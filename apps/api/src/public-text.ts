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

/*
 * Legacy markers: raw upstream text followed them up to the end of the field, possibly with `;` or `)` inside, so
 * everything from a marker that is not a fixed phrase to the end is dropped (an old row loses its tail, never leaks).
 */
const QUOTE_FAILED = new RegExp(`quote failed: (?!${KIND}(?:;|$))[\\s\\S]*$`);
const FAILED_PAREN = new RegExp(`failed \\((?!${KIND}\\))[\\s\\S]*$`);
const KIND_MESSAGE = new RegExp(`(^|\\(|: )(${KINDS}): [\\s\\S]*$`);
const UNSAFE = /:\/\/|<[a-z/!]|&(?:lt|gt|#\d+);|[\n\r]|\bat \S+ \(/i;
const FAILURE = new RegExp(
  `^(?:(?:cycle )?failed: ${KIND}|collector stopped before the cycle finished)$`,
);
const MAX_SHOWN = 500;

/**
 * A stored reason or summary as served (rows written before the fixed phrases included). Anything still looking like
 * a URL, HTML or a stack becomes `failed`; the check runs on the whole text, and only a clean result is cut.
 */
export function publicText(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const out = s
    .replace(QUOTE_FAILED, 'quote failed: unknown error')
    .replace(FAILED_PAREN, 'failed (unknown error)')
    .replace(KIND_MESSAGE, '$1$2');
  if (UNSAFE.test(out)) return 'failed';
  return out.length > MAX_SHOWN ? `${out.slice(0, MAX_SHOWN)}…` : out;
}

/** A field that only ever holds a failure (a failed source's detail, a cycle error): fixed phrases only. */
export function publicFailure(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  return FAILURE.test(s) ? s : 'failed: unknown error';
}

export const publicObservation = <T extends { reason: string | null }>(o: T): T => ({
  ...o,
  reason: publicText(o.reason),
});

const objects = (xs: unknown): Record<string, unknown>[] =>
  Array.isArray(xs)
    ? xs.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : [];

/** A collector cycle row as served: its error and every source detail cleaned. */
export function publicCycle<T extends { error: string | null; sources: unknown }>(c: T): T {
  return {
    ...c,
    error: publicFailure(c.error),
    sources: objects(c.sources).map((s) => ({
      ...s,
      detail: s.health === 'unavailable' ? publicFailure(s.detail) : publicText(s.detail),
    })),
  };
}

const publicScored = (s: Record<string, unknown>) => {
  const quote = typeof s.quote === 'object' && s.quote !== null ? s.quote : null;
  return {
    ...s,
    ...('excluded' in s ? { excluded: publicText(s.excluded) } : {}),
    ...(quote && 'reason' in quote
      ? { quote: { ...quote, reason: publicText(quote.reason) ?? 'failed' } }
      : {}),
  };
};

/** A stored route as served: its reason and each scored quote's `reason` / `excluded` (`quotes.scored`). */
export function publicRoute<T extends { reason: string; quotes: unknown }>(r: T): T {
  const q = r.quotes as { scored?: unknown } | null;
  const quotes =
    q && Array.isArray(q.scored) ? { ...q, scored: objects(q.scored).map(publicScored) } : q;
  return { ...r, reason: publicText(r.reason) ?? 'failed', quotes };
}
