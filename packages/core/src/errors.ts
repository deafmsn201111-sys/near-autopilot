/** Base class so callers can distinguish domain failures from programmer errors. */
export class AutopilotError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A price needed for valuation is missing. Valuation must fail closed. */
export class MissingPriceError extends AutopilotError {
  constructor(readonly token: string) {
    super('MISSING_PRICE', `No oracle price for token ${token}`);
  }
}

/** A contract or RPC response did not match the shape this code was written against. */
export class UnexpectedResponseError extends AutopilotError {
  constructor(source: string, detail: string, options?: { cause?: unknown }) {
    super('UNEXPECTED_RESPONSE', `${source}: ${detail}`, options);
  }
}

/** An on-chain precondition (e.g. storage registration) is not satisfied; do not send. */
export class PreconditionError extends AutopilotError {
  constructor(message: string) {
    super('PRECONDITION_FAILED', message);
  }
}

export class UnsupportedIntentError extends AutopilotError {
  constructor(kind: string) {
    super('UNSUPPORTED_INTENT', `No planner supports intent kind "${kind}"`);
  }
}

export class RpcError extends AutopilotError {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super('RPC_ERROR', message, options);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
