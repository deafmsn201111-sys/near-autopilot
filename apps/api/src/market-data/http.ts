/**
 * Bounded JSON-over-HTTP client for market data sources: per-attempt timeout, a fixed number of retries with
 * exponential backoff and equal jitter, Retry-After on 429/503, and a cap on requests in flight. It never retries
 * forever and never retries a request that cannot succeed (401/403/404/other 4xx).
 */
export type MarketHttpErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_response'
  | 'http_error';

export class MarketHttpError extends Error {
  constructor(
    readonly kind: MarketHttpErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'MarketHttpError';
  }
}

export interface HttpJsonClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxConcurrent?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (e: { attempt: number; kind: MarketHttpErrorKind; delayMs: number }) => void;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

export class HttpJsonClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sem: Semaphore;
  private readonly o: Required<
    Pick<HttpJsonClientOptions, 'timeoutMs' | 'maxRetries' | 'baseDelayMs' | 'maxDelayMs'>
  >;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: HttpJsonClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sem = new Semaphore(options.maxConcurrent ?? 2);
    this.o = {
      timeoutMs: options.timeoutMs ?? 8_000,
      maxRetries: options.maxRetries ?? 2,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 8_000,
    };
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /** GET and parse JSON. Headers (e.g. an Authorization bearer) are sent but never included in any error. */
  async getJson(url: string, headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sem.run(() => this.once(url, headers));
      } catch (error) {
        const e =
          error instanceof MarketHttpError
            ? error
            : new MarketHttpError('unavailable', 'request failed', true);
        if (!e.retryable || attempt >= this.o.maxRetries) throw e;
        const exp = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt);
        const jittered = exp / 2 + (this.random() * exp) / 2;
        const delayMs = Math.round(
          Math.min(this.o.maxDelayMs, Math.max(jittered, e.retryAfterMs ?? 0)),
        );
        this.options.onRetry?.({ attempt: attempt + 1, kind: e.kind, delayMs });
        await this.sleep(delayMs);
      }
    }
  }

  private async once(url: string, headers: Readonly<Record<string, string>>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.o.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', ...headers },
        signal: controller.signal,
      });
    } catch {
      throw controller.signal.aborted
        ? new MarketHttpError('timeout', `no response within ${this.o.timeoutMs} ms`, true)
        : new MarketHttpError('unavailable', 'network error', true);
    } finally {
      clearTimeout(timer);
    }
    const s = response.status;
    if (s === 429 || s === 503) {
      const after = parseRetryAfter(response.headers.get('retry-after'), Date.now());
      throw new MarketHttpError(s === 429 ? 'rate_limit' : 'unavailable', `HTTP ${s}`, true, after);
    }
    if (s === 401)
      throw new MarketHttpError('unauthorized', 'HTTP 401 (API key missing or rejected)', false);
    if (s === 403)
      throw new MarketHttpError('unauthorized', 'HTTP 403 (not entitled to this resource)', false);
    if (s === 404) throw new MarketHttpError('not_found', 'HTTP 404', false);
    if (s === 408 || s === 504) throw new MarketHttpError('timeout', `HTTP ${s}`, true);
    if (s >= 500) throw new MarketHttpError('unavailable', `HTTP ${s}`, true);
    if (!response.ok) throw new MarketHttpError('http_error', `HTTP ${s}`, false);
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MarketHttpError('invalid_response', 'body is not JSON', true);
    }
  }
}
