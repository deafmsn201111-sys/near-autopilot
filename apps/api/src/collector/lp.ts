import { compareDecimal, parseDecimal, type Decimal } from '../market-data/decimal';
import { dec, fromRaw, mul, toWad } from '../yield/math';
import { WINDOWS, type FeeWindow } from './history';
import type { TokenPrice } from './model';

/**
 * LP ENTRY SIMULATION for a two-token constant-product (SIMPLE_POOL) pool. Analysis only: nothing here can be
 * executed. Assumptions (stated in every result): the capital C starts in the pool's first token; half is swapped
 * through THIS pool (fee + price impact at the current reserves, valued at reference prices), both halves are added,
 * and on exit the position is withdrawn and the second half swapped back. Fees are the realised LP fee rate of the
 * best available history window, extrapolated linearly to the horizon and diluted by the added liquidity. IL is the
 * constant-product formula for a price move equal to the observed range of the pool price over that window scaled by
 * sqrt(horizon / window). Rewards are NOT included (no Rhea farm data is confirmed).
 */
export interface LpSimInput {
  readonly poolKey: string;
  readonly tokens: readonly [string, string];
  readonly reserves: readonly [bigint, bigint];
  readonly feeBps: number;
  readonly decimals: ReadonlyMap<string, number | null>;
  readonly prices: ReadonlyMap<string, TokenPrice>;
  readonly capitalUsd: number;
  readonly horizonDays: number;
  readonly gasUsdPerTx: number;
  readonly windows: readonly FeeWindow[];
  /** Min/max of reserve_b / reserve_a (raw units) over the chosen window, from stored observations. */
  readonly rawRatioRange: {
    readonly min: number;
    readonly max: number;
    readonly samples: number;
  } | null;
}

export interface LpSimResult {
  readonly poolKey: string;
  readonly status: 'OK' | 'INSUFFICIENT_DATA';
  readonly reason: string | null;
  readonly capitalUsd: number;
  readonly horizonDays: number;
  readonly window: string | null;
  readonly poolShare: string | null;
  readonly tokenSplit: readonly string[] | null;
  readonly expectedFeesUsd: string | null;
  readonly rewardsUsd: '0';
  readonly rewardsNote: string;
  readonly priceMoveAssumed: string | null;
  readonly impermanentLossUsd: string | null;
  readonly entryCostUsd: string | null;
  readonly exitCostUsd: string | null;
  readonly gasUsd: string | null;
  readonly netReturnUsd: string | null;
  readonly netReturnPct: string | null;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  readonly risks: readonly string[];
  readonly assumptions: string;
}

const ASSUMPTIONS =
  'capital starts in the first pool token; half swapped through this pool; fees = realised LP fee rate of the history window, linear, diluted by the position; IL for the observed price range scaled by sqrt(horizon/window); no rewards; analysis only, nothing is executed';

/** Constant-product swap: out = R_out * in * (1 - fee) / (R_in + in * (1 - fee)). Raw units. */
export function swapOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inAfterFee = amountIn * BigInt(10_000 - feeBps);
  return (reserveOut * inAfterFee) / (reserveIn * 10_000n + inAfterFee);
}

/** Impermanent loss of a 50/50 constant-product position for price ratio r: 2*sqrt(r)/(1+r) - 1 (<= 0). */
export function impermanentLoss(r: number): number {
  if (!(r > 0) || !Number.isFinite(r)) throw new RangeError('price ratio must be positive');
  return (2 * Math.sqrt(r)) / (1 + r) - 1;
}

const toNumber = (d: Decimal): number => Number(toWad(d)) / 1e18;
const usd = (n: number): string => n.toFixed(6);

function pickWindow(windows: readonly FeeWindow[]): FeeWindow | null {
  for (const name of ['30D', '7D', '24H', '1H', 'SINCE_FIRST'] as const) {
    const w = windows.find((x) => x.window === name && x.quality === 'OK' && x.annualizedApr);
    if (w) return w;
  }
  return null;
}

export function simulateLpEntry(input: LpSimInput): LpSimResult {
  const base = {
    poolKey: input.poolKey,
    capitalUsd: input.capitalUsd,
    horizonDays: input.horizonDays,
    rewardsUsd: '0' as const,
    rewardsNote: 'rewards not included: no confirmed Rhea farm data',
    assumptions: ASSUMPTIONS,
  };
  const fail = (reason: string): LpSimResult => ({
    ...base,
    status: 'INSUFFICIENT_DATA',
    reason,
    window: null,
    poolShare: null,
    tokenSplit: null,
    expectedFeesUsd: null,
    priceMoveAssumed: null,
    impermanentLossUsd: null,
    entryCostUsd: null,
    exitCostUsd: null,
    gasUsd: null,
    netReturnUsd: null,
    netReturnPct: null,
    confidence: null,
    risks: [],
  });
  const [ta, tb] = input.tokens;
  const pa = input.prices.get(ta);
  const pb = input.prices.get(tb);
  const da = input.decimals.get(ta) ?? null;
  const db = input.decimals.get(tb) ?? null;
  if (!pa || !pb || da === null || db === null)
    return fail('a pool token has no usable price or decimals');
  if (pa.quality !== 'OK' || pb.quality !== 'OK')
    return fail('prices are low-confidence: no LP simulation');
  const window = pickWindow(input.windows);
  if (!window || !window.annualizedApr || !window.seconds)
    return fail('no valid fee history window');
  const apr = parseDecimal(window.annualizedApr);
  const endTvl = window.endTvlUsd ? parseDecimal(window.endTvlUsd) : null;
  if (!apr || !endTvl || endTvl.mantissa <= 0n) return fail('fee window incomplete');

  const [ra, rb] = input.reserves;
  const C = input.capitalUsd;
  const tvl = toNumber(endTvl);
  // Entry: C in token A; swap half to B through the pool.
  const priceA = toNumber(pa.usd);
  const halfA =
    BigInt(Math.floor((C / 2 / priceA) * 10 ** Math.min(da, 18))) *
    10n ** BigInt(Math.max(da - 18, 0));
  const outB = swapOut(halfA, ra, rb, input.feeBps);
  const outBUsd = toNumber(mul(fromRaw(outB, db), pb.usd));
  const entryCost = Math.max(0, C / 2 - outBUsd);
  // Exit: swap the B half back through the pool (same reserves: a symmetric estimate of the exit cost).
  const backA = swapOut(outB, rb, ra, input.feeBps);
  const backAUsd = toNumber(mul(fromRaw(backA, da), pa.usd));
  const exitCost = Math.max(0, outBUsd - backAUsd);
  const gas = 4 * input.gasUsdPerTx; // swap + add_liquidity, remove_liquidity + swap
  const deployed = C / 2 + outBUsd;
  const share = deployed / (tvl + deployed);
  const fees = deployed * toNumber(apr) * (input.horizonDays / 365) * (tvl / (tvl + deployed));

  // Observed range of the pool price (B per A; decimals cancel in the ratio) -> assumed move over the horizon.
  const range = input.rawRatioRange;
  const risks: string[] = [];
  let move = 0;
  const ranged = !!range && range.samples >= 2 && range.min > 0;
  if (ranged && range) {
    move = (range.max / range.min - 1) * Math.sqrt((input.horizonDays * 86_400) / window.seconds);
  } else
    risks.push('price range unknown: IL assumed from a single point (0 move) - LOW confidence');
  move = Math.min(move, 0.9);
  const il = -impermanentLoss(1 + move) * deployed;
  const net = fees - il - entryCost - exitCost - gas;
  if (share > 0.01) risks.push(`position would be ${(share * 100).toFixed(2)} % of the pool`);
  if (window.seconds < WINDOWS['24H'])
    risks.push(`fee rate from only ${Math.round(window.seconds / 60)} min of history`);
  if (compareDecimal(endTvl, dec(1_000_000n)) < 0) risks.push('pool below $1M: exit depth limited');
  return {
    ...base,
    status: 'OK',
    reason: null,
    window: window.window,
    poolShare: share.toFixed(8),
    tokenSplit: [usd(C / 2), usd(outBUsd)],
    expectedFeesUsd: usd(fees),
    priceMoveAssumed: move.toFixed(6),
    impermanentLossUsd: usd(il),
    entryCostUsd: usd(entryCost),
    exitCostUsd: usd(exitCost),
    gasUsd: usd(gas),
    netReturnUsd: usd(net),
    netReturnPct: ((net / C) * 100).toFixed(4),
    confidence: ranged ? (window.confidence ?? 'LOW') : 'LOW',
    risks,
  };
}

/** For strategy comparison: exact constant-product cost of swapping `capitalUsd` of A into B through one pool. */
export function swapCostUsd(
  capitalUsd: number,
  reserves: readonly [bigint, bigint],
  feeBps: number,
  decimals: readonly [number, number],
  prices: readonly [Decimal, Decimal],
): number {
  const [da, db] = decimals;
  const priceA = toNumber(prices[0]);
  const amountA =
    BigInt(Math.floor((capitalUsd / priceA) * 10 ** Math.min(da, 18))) *
    10n ** BigInt(Math.max(da - 18, 0));
  const out = swapOut(amountA, reserves[0], reserves[1], feeBps);
  return Math.max(0, capitalUsd - toNumber(mul(fromRaw(out, db), prices[1])));
}
