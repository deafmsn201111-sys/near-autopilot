import { RpcError, type RpcErrorKind } from '@near-autopilot/core';

export interface RpcRetryEvent {
  readonly method: string;
  /** 1-based number of the attempt that just failed. */
  readonly attempt: number;
  readonly kind: RpcErrorKind;
  readonly delayMs: number;
  readonly message: string;
}

export interface NearRpcClientOptions {
  readonly url: string;
  /** Extra headers, e.g. an API key for a hosted RPC provider. Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Retries for idempotent reads only (rate limit, timeout, network error, HTTP 5xx). Default 3. */
  readonly maxRetries?: number;
  /** First backoff step; doubles per attempt, with jitter. Default 300 ms. */
  readonly baseDelayMs?: number;
  /** Upper bound for any single wait, including a server's Retry-After. Default 15 s. */
  readonly maxDelayMs?: number;
  /** Requests in flight at once; the rest queue. Default 4 (public endpoints rate-limit bursts). */
  readonly maxConcurrent?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** [0, 1) source for jitter; injectable for tests. */
  readonly random?: () => number;
  /** Called before each retry wait, e.g. to log it. */
  readonly onRetry?: (event: RpcRetryEvent) => void;
}

interface JsonRpcEnvelope {
  readonly result?: unknown;
  readonly error?: {
    readonly name?: string;
    readonly message?: string;
    readonly data?: unknown;
    readonly cause?: { readonly name?: string; readonly info?: unknown };
  };
}

const isEnvelope = (body: unknown): body is JsonRpcEnvelope =>
  body !== null &&
  typeof body === 'object' &&
  !Array.isArray(body) &&
  ('result' in body || 'error' in body);

/** Node-side errors that are transient by definition; anything else (UNKNOWN_ACCOUNT, ...) is a real answer. */
const TRANSIENT_RPC_ERRORS: Readonly<Record<string, RpcErrorKind>> = {
  UNKNOWN_BLOCK: 'unavailable',
  INTERNAL_ERROR: 'unavailable',
  NO_SYNCED_BLOCKS: 'unavailable',
  TIMEOUT_ERROR: 'timeout',
};

/** Counting semaphore: bounds concurrent requests so one cycle cannot burst past a provider's rate limit. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Minimal JSON-RPC 2.0 client for a NEAR node. No signing, no state.
 *
 * Only idempotent calls are retried, with exponential backoff and jitter (and a server's Retry-After, capped). A
 * non-idempotent call (a transaction broadcast) is sent exactly once whatever happens: re-sending could execute it
 * twice or mask an outcome the caller must reconcile. Failures are never turned into results: every error surfaces as
 * an RpcError with a `kind`.
 */
export class NearRpcClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry: ((event: RpcRetryEvent) => void) | undefined;
  private readonly limiter: Semaphore;
  private nextId = 1;

  constructor(options: NearRpcClientOptions) {
    this.url = options.url;
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 300;
    this.maxDelayMs = options.maxDelayMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
    this.limiter = new Semaphore(Math.max(1, options.maxConcurrent ?? 4));
  }

  /**
   * @param idempotent when false (e.g. broadcast) the request is sent exactly once.
   */
  async call(
    method: string,
    params: unknown,
    options: { idempotent?: boolean } = {},
  ): Promise<unknown> {
    const attempts = (options.idempotent ?? true) ? this.maxRetries + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.limiter.run(() => this.callOnce(method, params));
      } catch (error) {
        if (!(error instanceof RpcError) || !error.retryable || attempt >= attempts) throw error;
        const delayMs = this.delayFor(attempt, error);
        this.onRetry?.({ method, attempt, kind: error.kind, delayMs, message: error.message });
        await this.sleep(delayMs);
      }
    }
  }

  /** Exponential backoff with "equal jitter" (half fixed, half random), or the server's Retry-After if longer. */
  private delayFor(attempt: number, error: RpcError): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    const jittered = exp / 2 + this.random() * (exp / 2);
    const hinted = error instanceof RateLimitedError ? (error.retryAfterMs ?? 0) : 0;
    return Math.round(Math.min(this.maxDelayMs, Math.max(jittered, hinted)));
  }

  private async callOnce(method: string, params: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new RpcError(
        timedOut
          ? `RPC ${method} timed out after ${this.timeoutMs} ms`
          : `RPC ${method} request failed (endpoint unreachable)`,
        true,
        { cause, kind: timedOut ? 'timeout' : 'unavailable' },
      );
    }

    if (response.status === 429) {
      throw new RateLimitedError(method, parseRetryAfter(response.headers.get('retry-after')));
    }
    if (response.status === 408 || response.status === 504) {
      throw new RpcError(`RPC ${method} returned HTTP ${response.status}`, true, {
        kind: 'timeout',
      });
    }
    if (response.status >= 500) {
      throw new RpcError(`RPC ${method} returned HTTP ${response.status}`, true, {
        kind: 'unavailable',
      });
    }
    if (!response.ok) {
      throw new RpcError(`RPC ${method} returned HTTP ${response.status}`, false, {
        kind: 'http_error',
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      // An HTML error page from a proxy in front of the node: transient for a read, never a result.
      throw new RpcError(`RPC ${method} response body is not JSON`, true, {
        cause,
        kind: 'invalid_response',
      });
    }
    if (!isEnvelope(body)) {
      throw new RpcError(`RPC ${method} response is not a JSON-RPC envelope`, false, {
        kind: 'invalid_response',
      });
    }
    if (body.error) {
      const name = body.error.cause?.name ?? body.error.name ?? 'RPC_ERROR';
      const transient = TRANSIENT_RPC_ERRORS[name];
      throw new RpcError(
        `RPC ${method} failed: ${name}: ${body.error.message ?? ''}`.trim(),
        transient !== undefined,
        { kind: transient ?? 'rpc_error' },
      );
    }
    if (!('result' in body) || body.result === undefined) {
      throw new RpcError(`RPC ${method} response has no result`, false, {
        kind: 'invalid_response',
      });
    }
    return body.result;
  }
}

/** HTTP 429. Carries the server's Retry-After hint, if any. */
export class RateLimitedError extends RpcError {
  constructor(
    method: string,
    readonly retryAfterMs: number | null,
  ) {
    super(`RPC ${method} was rate limited (HTTP 429)`, true, { kind: 'rate_limit' });
  }
}

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
