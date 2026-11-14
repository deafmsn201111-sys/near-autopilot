import type { PreparedCascade } from './prepare-types';

export type ImpactTier = 'none' | 'watch' | 'act' | 'block' | 'unknown';

/** Under 1% a fact; up to 5% a notice; above 5% an "I understand" gate; above 15% no signing (as Uniswap). */
export function impactTier(pct: number | null): ImpactTier {
  if (pct === null || pct < 1) return 'none';
  if (pct <= 5) return 'watch';
  return pct <= 15 ? 'act' : 'block';
}

/** A swap whose impact could not be measured (pool unread, stable pool) asks for the same acknowledgement as a costly one. */
export function swapImpactTier(c: PreparedCascade): ImpactTier {
  const swap = c.cost?.swap;
  if (!swap) return 'none';
  return swap.priceImpactPct === null ? 'unknown' : impactTier(swap.priceImpactPct);
}

export type SignLock = { ready: true } | { ready: false; reason: string; gate?: true };

/** Why Sign is locked, always as a visible sentence: who may sign first, then the price-impact gate. */
export function signLock({
  blocked,
  tier,
  ack,
}: {
  blocked: string | null;
  tier: ImpactTier;
  ack: boolean;
}): SignLock {
  if (blocked) return { ready: false, reason: blocked };
  if (tier === 'block')
    return {
      ready: false,
      reason: 'The price impact is above 15%: swap a smaller part, or split it over several days.',
    };
  if ((tier === 'act' || tier === 'unknown') && !ack)
    return { ready: false, gate: true, reason: 'Tick “I understand” above to unlock signing.' };
  return { ready: true };
}

export interface BalanceChange {
  readonly dir: 'out' | 'in';
  readonly human: number;
  readonly symbol: string;
  readonly usd?: number;
  /** A swap's guaranteed minimum; the transaction reverts below it. */
  readonly min?: number;
}

const change = (dir: BalanceChange['dir'], a: { human: number; symbol: string; usd?: number }) => ({
  dir,
  human: a.human,
  symbol: a.symbol,
  ...(a.usd !== undefined ? { usd: a.usd } : {}),
});

/** What leaves the wallet and what comes back, from the amounts the server sized. Nothing is estimated here. */
export function balanceChanges(c: PreparedCascade): BalanceChange[] {
  const out = (c.amounts ?? (c.amount ? [c.amount] : [])).map((a) => change('out', a));
  const swap = c.cost?.swap;
  const back = swap
    ? [{ ...change('in', swap.estReceived), min: swap.minReceived.human }]
    : (c.freed ?? []).map((a) => change('in', a));
  return [...out, ...back];
}

/** The USD a swap loses to the pool (impact and fee), when both sides are priced. */
export function swapLossUsd(c: PreparedCascade): number | null {
  const sent = c.amount?.usd;
  const got = c.cost?.swap?.estReceived.usd;
  return sent === undefined || got === undefined ? null : Math.max(0, sent - got);
}

const PLAIN: readonly [RegExp, string][] = [
  [/^prepare failed \(HTTP/i, 'Could not build this right now. Try again in a minute.'],
  [
    /^no confirmed price/i,
    'There is no confirmed price for this token right now, so the amount cannot be sized safely. Try again after the next market update.',
  ],
  [/^no route for/i, 'No allowlisted pool can make this swap right now.'],
  [
    /^the resolved .*zero$/i,
    'At your current balance this comes out to zero, so there is nothing to sign.',
  ],
  [
    /^assembled cascade failed safety checks/i,
    'The transaction did not pass our safety checks, so it is not offered for signing.',
  ],
];

export function plainError(message: string, status: number): string {
  if (status === 429) return 'Too many requests. Wait a few minutes and try again.';
  if (status === 0) return 'Could not reach the server. Check your connection and try again.';
  if (status >= 500) return 'Could not build this right now. Try again in a minute.';
  const known = PLAIN.find(([re]) => re.test(message));
  if (known) return known[1];
  const s = message.trim();
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}`;
}

/** Why this view cannot sign at all, known before the user tries; null when the connected owner can. */
export function signBlocked({
  account,
  connected,
  signingEnabled,
}: {
  account: string;
  connected: string;
  signingEnabled: boolean;
}): string | null {
  if (!signingEnabled)
    return 'Signing is off on this server. This preview is exactly what your wallet would show.';
  if (connected !== account)
    return `Only the owner of ${account} can sign. This preview is exactly what they would see.`;
  return null;
}
