import { formatDecimal, parseDecimal, type Decimal } from '../market-data/decimal';
import { add, dec, div, fromRaw, mul } from '../yield/math';
import type { TokenPrice } from './model';

/** A stored pool observation, as the window math needs it. */
export interface PoolPoint {
  readonly blockHeight: number;
  readonly at: Date;
  readonly reserves: readonly string[];
  readonly volumesIn: readonly string[] | null;
  readonly feeBps: number | null;
  readonly adminFeeBps: number | null;
  readonly tvlUsd: string | null;
}

export type WindowQuality =
  'OK' | 'LOW_CONFIDENCE' | 'STALE_DATA' | 'INSUFFICIENT_HISTORY' | 'DATA_INVALID';

export const WINDOWS = { '1H': 3_600, '24H': 86_400, '7D': 604_800, '30D': 2_592_000 } as const;
export type WindowName = keyof typeof WINDOWS | 'SINCE_FIRST';

export interface FeeWindow {
  readonly window: WindowName;
  readonly quality: WindowQuality;
  readonly reason: string | null;
  readonly observations: number;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly seconds: number | null;
  readonly volumeUsd: string | null;
  readonly grossFeesUsd: string | null;
  readonly adminFeesUsd: string | null;
  readonly lpFeesUsd: string | null;
  readonly avgTvlUsd: string | null;
  readonly endTvlUsd: string | null;
  /** LP fees / average pool value over the window: what an LP actually earned, NOT annualised. */
  readonly realizedYield: string | null;
  /** The same, scaled to a year: a short-term extrapolation, never a forecast. */
  readonly annualizedApr: string | null;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
}

const YEAR = 31_536_000n;
const big = (s: string | undefined): bigint | null => (s && /^\d+$/.test(s) ? BigInt(s) : null);

const empty = (
  window: WindowName,
  quality: WindowQuality,
  reason: string,
  n: number,
): FeeWindow => ({
  window,
  quality,
  reason,
  observations: n,
  startAt: null,
  endAt: null,
  seconds: null,
  volumeUsd: null,
  grossFeesUsd: null,
  adminFeesUsd: null,
  lpFeesUsd: null,
  avgTvlUsd: null,
  endTvlUsd: null,
  realizedYield: null,
  annualizedApr: null,
  confidence: null,
});

/**
 * USD value of the input volume traded between two readings: the increase of each token's cumulative input volume,
 * valued at the CURRENT price. Null when a reading has no volumes, a token has no price or decimals, or a cumulative
 * volume decreased. Needs no pool value, so it can be used before the pool is valued (LP eligibility).
 */
export function volumeUsdBetween(
  start: PoolPoint,
  end: PoolPoint,
  tokens: readonly string[],
  decimals: ReadonlyMap<string, number | null>,
  prices: ReadonlyMap<string, TokenPrice>,
): Decimal | null {
  if (!start.volumesIn || !end.volumesIn) return null;
  let volume: Decimal = dec(0n);
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k] ?? '';
    const p = prices.get(t);
    const d = decimals.get(t) ?? null;
    const a = big(start.volumesIn[k]);
    const b = big(end.volumesIn[k]);
    if (!p || d === null || a === null || b === null || b < a) return null;
    volume = add(volume, mul(fromRaw(b - a, d), p.usd));
  }
  return volume;
}

/**
 * Fee yield of a two-token constant-product pool over one window, from cumulative input volumes (fees are charged on
 * swap input, so each swap is counted once). The window is [the latest point at least `seconds` before the end, end].
 * Every point in between must have increasing block heights and non-decreasing cumulative volumes, or DATA_INVALID.
 * Volumes are valued at the CURRENT prices; the pool value is the average of the stored values in the window.
 */
export function feeWindow(
  window: WindowName,
  points: readonly PoolPoint[],
  tokens: readonly string[],
  decimals: ReadonlyMap<string, number | null>,
  prices: ReadonlyMap<string, TokenPrice>,
  now: Date,
  maxEndAgeSeconds: number,
  /** True when a stored observation inside the window failed the sequence check (block order / cumulative volume). */
  brokenInside = false,
): FeeWindow {
  const sorted = [...points]
    .filter((p) => p.volumesIn)
    .sort((a, b) => a.blockHeight - b.blockHeight);
  const end = sorted[sorted.length - 1];
  if (!end) return empty(window, 'INSUFFICIENT_HISTORY', 'no observation with volumes', 0);
  if ((now.getTime() - end.at.getTime()) / 1000 > maxEndAgeSeconds)
    return empty(
      window,
      'STALE_DATA',
      `latest observation is older than ${maxEndAgeSeconds} s`,
      sorted.length,
    );
  const span = window === 'SINCE_FIRST' ? null : WINDOWS[window];
  const candidates =
    span === null
      ? sorted.slice(0, 1)
      : sorted.filter((p) => end.at.getTime() - p.at.getTime() >= span * 1000);
  const start = candidates[candidates.length - 1];
  if (!start || start === end)
    return empty(
      window,
      'INSUFFICIENT_HISTORY',
      `no observation ${span ?? 0} s before the latest`,
      sorted.length,
    );
  const inWindow = sorted.filter((p) => p.blockHeight >= start.blockHeight);
  if (brokenInside)
    return empty(
      window,
      'DATA_INVALID',
      'an observation inside the window failed the sequence check',
      inWindow.length,
    );
  for (let i = 1; i < inWindow.length; i += 1) {
    const a = inWindow[i - 1];
    const b = inWindow[i];
    if (!a || !b || b.blockHeight <= a.blockHeight || b.at < a.at)
      return empty(
        window,
        'DATA_INVALID',
        'block order broken between observations',
        inWindow.length,
      );
    for (let k = 0; k < tokens.length; k += 1) {
      const va = big(a.volumesIn?.[k]);
      const vb = big(b.volumesIn?.[k]);
      if (va === null || vb === null || vb < va)
        return empty(
          window,
          'DATA_INVALID',
          'cumulative volume decreased or unreadable',
          inWindow.length,
        );
    }
    if (a.feeBps !== b.feeBps || a.adminFeeBps !== b.adminFeeBps)
      return empty(
        window,
        'DATA_INVALID',
        'fee configuration changed inside the window',
        inWindow.length,
      );
  }
  const unpriced = tokens.find((t) => !prices.get(t) || (decimals.get(t) ?? null) === null);
  if (unpriced !== undefined)
    return empty(window, 'LOW_CONFIDENCE', `${unpriced}: no usable price`, inWindow.length);
  const low = tokens.some((t) => prices.get(t)?.quality !== 'OK');
  const volume = volumeUsdBetween(start, end, tokens, decimals, prices);
  if (volume === null)
    return empty(
      window,
      'DATA_INVALID',
      'cumulative volume decreased or unreadable',
      inWindow.length,
    );
  const fee = end.feeBps ?? null;
  const admin = end.adminFeeBps ?? null;
  if (fee === null || admin === null)
    return empty(window, 'DATA_INVALID', 'fee configuration unknown', inWindow.length);
  const tvls = inWindow
    .flatMap((p) => (p.tvlUsd ? [parseDecimal(p.tvlUsd)] : []))
    .filter((x): x is Decimal => !!x);
  const endTvl = end.tvlUsd ? parseDecimal(end.tvlUsd) : null;
  if (tvls.length === 0 || !endTvl || endTvl.mantissa <= 0n)
    return empty(window, 'DATA_INVALID', 'pool value unknown', inWindow.length);
  const avgTvl = div(
    tvls.reduce((s, x) => add(s, x), dec(0n)),
    dec(BigInt(tvls.length)),
  );
  const gross = mul(volume, dec(BigInt(fee), -4));
  const adminFees = mul(gross, dec(BigInt(admin), -4));
  const lp = mul(gross, dec(BigInt(10_000 - admin), -4));
  const seconds = Math.round((end.at.getTime() - start.at.getTime()) / 1000);
  const realized = div(lp, avgTvl);
  const annual = div(mul(realized, dec(YEAR)), dec(BigInt(Math.max(seconds, 1))));
  const confidence = low
    ? 'LOW'
    : seconds >= WINDOWS['7D']
      ? 'HIGH'
      : seconds >= WINDOWS['24H']
        ? 'MEDIUM'
        : 'LOW';
  return {
    window,
    quality: low ? 'LOW_CONFIDENCE' : 'OK',
    reason: low ? 'valued with low-confidence prices' : null,
    observations: inWindow.length,
    startAt: start.at.toISOString(),
    endAt: end.at.toISOString(),
    seconds,
    volumeUsd: formatDecimal(volume),
    grossFeesUsd: formatDecimal(gross),
    adminFeesUsd: formatDecimal(adminFees),
    lpFeesUsd: formatDecimal(lp),
    avgTvlUsd: formatDecimal(avgTvl),
    endTvlUsd: formatDecimal(endTvl),
    realizedYield: formatDecimal(realized),
    annualizedApr: formatDecimal(annual),
    confidence,
  };
}

/** Generic series window for Burrow / prices: first and last value inside the window and the change. */
export function seriesWindow(
  points: readonly { at: Date; value: string | null }[],
  seconds: number,
): { start: string | null; end: string | null; points: number; quality: WindowQuality } {
  const sorted = points
    .filter((p) => p.value !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const end = sorted[sorted.length - 1];
  if (!end) return { start: null, end: null, points: 0, quality: 'INSUFFICIENT_HISTORY' };
  const startCandidates = sorted.filter((p) => end.at.getTime() - p.at.getTime() >= seconds * 1000);
  const start = startCandidates[startCandidates.length - 1];
  if (!start)
    return { start: null, end: end.value, points: sorted.length, quality: 'INSUFFICIENT_HISTORY' };
  return {
    start: start.value,
    end: end.value,
    points: sorted.filter((p) => p.at >= start.at).length,
    quality: 'OK',
  };
}
