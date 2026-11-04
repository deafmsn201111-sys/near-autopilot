import { RpcError, UnexpectedResponseError } from '@near-autopilot/core';

export interface NearRpcClientOptions {
  readonly url: string;
  /** Extra headers, e.g. an API key for a hosted RPC provider. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Retries for idempotent reads (network errors, HTTP 429/5xx). Default 2. */
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
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

/** Minimal JSON-RPC 2.0 client for a NEAR node. No signing, no state. */
export class NearRpcClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextId = 1;

  constructor(options: NearRpcClientOptions) {
    this.url = options.url;
    this.headers = { 'content-type': 'application/json', ...options.headers };
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await this.sleep(200 * 2 ** (attempt - 1));
      try {
        return await this.callOnce(method, params);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RpcError) || !error.retryable) throw error;
      }
    }
    throw lastError;
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
      throw new RpcError(`RPC ${method} request failed`, true, { cause });
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RpcError(`RPC ${method} returned HTTP ${response.status}`, true);
    }
    if (!response.ok) throw new RpcError(`RPC ${method} returned HTTP ${response.status}`, false);

    let body: JsonRpcEnvelope;
    try {
      body = (await response.json()) as JsonRpcEnvelope;
    } catch (cause) {
      throw new UnexpectedResponseError(`rpc:${method}`, 'response body is not JSON', { cause });
    }
    if (body.error) {
      const name = body.error.cause?.name ?? body.error.name ?? 'RPC_ERROR';
      const retryable = name === 'UNKNOWN_BLOCK' || name === 'INTERNAL_ERROR';
      throw new RpcError(
        `RPC ${method} failed: ${name}: ${body.error.message ?? ''}`.trim(),
        retryable,
      );
    }
    if (!('result' in body)) throw new UnexpectedResponseError(`rpc:${method}`, 'missing result');
    return body.result;
  }
}
