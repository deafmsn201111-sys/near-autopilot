import { ago, utcClock } from './format';

/**
 * A failed read in plain words. Only a missing or malformed account is about what the visitor typed; a rate limit, our server or
 * NEAR not answering is never their fault.
 */
export function plainReadError(
  status: number | null,
  error: string | null,
): { text: string; blamesInput: boolean } {
  if ((status === 404 || status === 400) && error)
    return { text: `${capitalize(error)}.`, blamesInput: true };
  if (status === 429)
    return {
      text: 'We are serving a lot of reads from your network right now. Wait a minute and try again.',
      blamesInput: false,
    };
  if (status === 0)
    return {
      text: 'Our server is not answering right now. Nothing in your wallet is affected; try again in a minute.',
      blamesInput: false,
    };
  if (status === 502)
    return {
      text: 'NEAR did not answer when we read the account. This is usually temporary; try again in a minute.',
      blamesInput: false,
    };
  return {
    text: 'Something failed on our side while reading it. Nothing in your wallet is affected; try again in a minute.',
    blamesInput: false,
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const RULES = 'Below is the rule-based result: the same agents and checks, without the AI ranking.';

/** The API's fallback codes that mean the AI run itself failed (not "off", "not the owner" or "nothing to rank"). */
const FAILED = {
  busy: 'busy',
  deadline: 'slow',
  model_error: 'failed',
  invalid_output: 'failed',
  loop_limit: 'failed',
  empty: 'failed',
  cancelled: 'stopped',
  cap: 'paused',
} as const;

const TEXT = {
  busy: ['The AI is busy right now.', `Try again in a few minutes. ${RULES}`],
  slow: ['The AI took too long.', `Run it again; it usually answers within a minute. ${RULES}`],
  unreachable: [
    'The AI could not be reached.',
    `Our server did not answer; try again in a minute. ${RULES}`,
  ],
  failed: ['The AI run failed.', `Run it again. ${RULES}`],
  stopped: ['The AI run was stopped.', `Run it again when you are ready. ${RULES}`],
  paused: ['AI analysis is paused for today.', `The daily AI budget is used up. ${RULES}`],
} as const;

/**
 * A failed AI run (#256): a transport failure has a status, a run the API ended on its side has a fallback code.
 * Null when the run did not fail.
 */
export function aiFailure({
  status,
  fallback,
  error = '',
}: {
  status?: number;
  fallback?: string | null;
  error?: string;
}): { title: string; detail: string; retry: boolean } | null {
  const kind = fallback
    ? (FAILED[fallback as keyof typeof FAILED] ?? null)
    : status === 429 || /busy|too many/i.test(error)
      ? 'busy'
      : status === 504 || /too long|timed? ?out|deadline/i.test(error)
        ? 'slow'
        : status === 0 || status === 502 || status === 503
          ? 'unreachable'
          : 'failed';
  if (!kind) return null;
  const [title, detail] = TEXT[kind];
  // A request we sent wrong (4xx) fails the same way on a retry.
  const ours = status !== undefined && status >= 400 && status < 500 && status !== 429;
  return { title, detail, retry: kind !== 'paused' && !ours };
}

/** Prices this many collector cycles old get a warning: one missed cycle is normal. */
const STALE_PRICE_CYCLES = 3;

/** What the page warns about when it shows an older read or prices that stopped updating (#256). */
export function staleNotices({
  read,
  prices,
  now,
}: {
  read: { stale: boolean; asOf: string | null; status: number | null; error: string | null };
  prices: { dataAsOf: string | null; intervalSeconds: number } | null;
  now: string;
}): { title: string; detail: string }[] {
  const out: { title: string; detail: string }[] = [];
  if (read.stale)
    out.push({
      title: "Couldn't refresh.",
      detail: `${read.asOf ? `Showing data from ${utcClock(read.asOf)} (${ago(read.asOf, now)}). ` : ''}${plainReadError(read.status, read.error).text}`,
    });
  const at = prices?.dataAsOf;
  if (at && Date.parse(now) - Date.parse(at) > STALE_PRICE_CYCLES * prices.intervalSeconds * 1000)
    out.push({
      title: 'Prices may be out of date.',
      detail: `The price feed last updated at ${utcClock(at)} (${ago(at, now)}); the values below use those prices.`,
    });
  return out;
}

/** "Add funds" could not open HOT's popup (D42): a plain line by the button, never a frozen modal. */
export function bridgeOpenError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/429|too many/i.test(message))
    return 'HOT is busy right now. Wait a minute and press Add funds again.';
  return 'HOT did not load. Check your connection and press Add funds again.';
}

export const NO_NEAR_ACCOUNT = 'Connect your NEAR wallet first, then add funds.';
export const CONNECT_FAILED = 'The wallet list did not open. Check your connection and try again.';

// Messages our API writes itself about the amount, the tokens or the address: already plain, about what was typed.
const OWN_QUOTE_ERROR =
  /^(The amount must|The recipient is not|1Click has no quote|Unknown token|Transfers to other chains are unavailable)/;

/** A withdraw quote that failed, in plain words inside the sheet; raw API text never reaches the screen. */
export function plainQuoteError(status: number, error: string): string {
  if (OWN_QUOTE_ERROR.test(error)) return error;
  if (status === 429) return 'Too many quotes in a short time. Wait a few minutes and try again.';
  if (status === 0)
    return 'Our server is not answering right now. Check your connection and try again.';
  if (status >= 500)
    return '1Click is not answering right now. Nothing was sent; try again in a minute.';
  return 'This amount or address cannot be quoted. Check them and try again.';
}
