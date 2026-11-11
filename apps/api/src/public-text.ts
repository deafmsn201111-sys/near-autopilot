import { RpcError } from '@near-autopilot/core';
import { MarketHttpError } from './market-data/http';

/**
 * Security item 6: failure text shown on public pages is a fixed phrase built from the error kind; the upstream
 * message (URLs, provider HTML, stack lines) goes to the log only.
 */
const KINDS = [
  'rate_limit',
  'timeout',
  'unavailable',
  'unauthorized',
  'not_found',
  'invalid_response',
  'rpc_error',
  'http_error',
].join('|');
const KIND = `(?:(?:${KINDS})(?: \\(HTTP \\d{3}\\))?|unknown error)`;

export function failureKind(e: unknown): string {
  if (e instanceof RpcError) return e.kind;
  if (e instanceof MarketHttpError) {
    const status = /^HTTP (\d{3})\b/.exec(e.message)?.[1];
    return status ? `${e.kind} (HTTP ${status})` : e.kind;
  }
  return 'unknown error';
}

const QUOTE_FAILED = new RegExp(`quote failed: (?!${KIND}(?:;|$))[^;]*`, 'g');
const FAILED_PAREN = new RegExp(`failed \\((?!${KIND}\\))[^;]*\\)`, 'g');
const KIND_MESSAGE = new RegExp(`\\b(${KINDS}): [^;)]*`, 'g');
const MAX_LENGTH = 500;
const UNSAFE = /:\/\/|<[a-z/!]|[\n\r]|\bat \S+ \(/i;
const FAILURE = new RegExp(
  `^(?:(?:cycle )?failed: ${KIND}|collector stopped before the cycle finished)$`,
);

/**
 * A stored reason or summary as served. Rows written before the fixed phrases may still hold raw upstream text after
 * a failure marker: that part is replaced, and anything still looking like a URL, HTML or a stack becomes `failed`.
 * Cut to MAX_LENGTH first, which also bounds the regex backtracking.
 */
export function publicText(s: string | null): string | null {
  if (s === null) return null;
  const out = (s.length > MAX_LENGTH ? `${s.slice(0, MAX_LENGTH)}…` : s)
    .replace(QUOTE_FAILED, 'quote failed: unknown error')
    .replace(FAILED_PAREN, 'failed (unknown error)')
    .replace(KIND_MESSAGE, '$1');
  return UNSAFE.test(out) ? 'failed' : out;
}

/** A field that only ever holds a failure (a failed source's detail, a cycle error): fixed phrases only. */
export function publicFailure(s: string | null): string | null {
  if (s === null) return null;
  return FAILURE.test(s) ? s : 'failed: unknown error';
}

export const publicObservation = <T extends { reason: string | null }>(o: T): T => ({
  ...o,
  reason: publicText(o.reason),
});

interface StoredCycle {
  readonly error: string | null;
  readonly sources: unknown;
}

/** A collector cycle row as served: its error and every source detail cleaned. */
export function publicCycle<T extends StoredCycle>(c: T): T {
  const sources = (c.sources ?? []) as { health: string; detail: string | null }[];
  return {
    ...c,
    error: publicFailure(c.error),
    sources: sources.map((s) => ({
      ...s,
      detail: s.health === 'unavailable' ? publicFailure(s.detail) : publicText(s.detail),
    })),
  };
}

type Scored = { excluded?: string | null; quote?: { reason?: string } };
const publicScored = (s: Scored): Scored => ({
  ...s,
  ...(s.excluded === undefined ? {} : { excluded: publicText(s.excluded) }),
  ...(s.quote?.reason === undefined
    ? {}
    : { quote: { ...s.quote, reason: publicText(s.quote.reason) ?? 'failed' } }),
});

/** A stored route as served: its reason and each scored quote's `reason` / `excluded` (`quotes.scored`). */
export function publicRoute<T extends { reason: string; quotes: unknown }>(r: T): T {
  const q = r.quotes as { scored?: unknown } | null;
  const quotes =
    q && Array.isArray(q.scored) ? { ...q, scored: (q.scored as Scored[]).map(publicScored) } : q;
  return { ...r, reason: publicText(r.reason) ?? 'failed', quotes };
}
