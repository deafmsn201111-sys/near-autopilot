import { isqrt, mulDiv, Q96, Q192, U256_MOD, Q128, type Directed } from './fixed';

/**
 * Concentrated-liquidity (Uniswap-v3-style) mathematics, all bigint, all exact.
 *
 * Model and conventions
 *  - Price P is token1 per token0 in RAW units. State is the square root: sqrtPriceX96 = sqrt(P) * 2^96.
 *  - A position holds liquidity L over [sqrtLower, sqrtUpper]. Token amounts are
 *        amount0 = L * (1/sqrtP_lo' - 1/sqrtUpper)        amount1 = L * (sqrtP_hi' - sqrtLower)
 *    where the primed bounds are clipped to the current price.
 *  - Ticks map to prices by P = 1.0001^tick. `sqrtRatioAtTick` is computed from the exact definition with 192-bit
 *    fixed point and rounded to nearest at Q96; it is accurate to well under 1 ulp but is NOT claimed to be
 *    bit-identical to any particular protocol's lookup table. When bit-exactness with a deployed pool matters, take
 *    sqrtPriceX96 from the pool itself (it is an input everywhere) and use that protocol's adapter for tick math.
 *  - Rounding: value withdrawn rounds DOWN, amounts to deposit round UP.
 */

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

/** sqrt(1.0001) in Q192, from exact integer square root. Truncation error < 2^-190. */
const SQRT_BASE_Q192 = isqrt((10_001n * (1n << 384n)) / 10_000n);

function powQ192(base: bigint, exponent: number): bigint {
  let result = Q192;
  let b = base;
  let e = exponent;
  while (e > 0) {
    if (e & 1) result = (result * b) >> 192n;
    e = Math.floor(e / 2);
    if (e > 0) b = (b * b) >> 192n;
  }
  return result;
}

/** sqrt(1.0001^tick) * 2^96, rounded to nearest. */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`);
  }
  const positive = powQ192(SQRT_BASE_Q192, Math.abs(tick));
  const q192 = tick >= 0 ? positive : (Q192 * Q192) / positive;
  return mulDiv(q192, 1n, Q96, 'nearest');
}

export const MIN_SQRT_RATIO = sqrtRatioAtTick(MIN_TICK);
export const MAX_SQRT_RATIO = sqrtRatioAtTick(MAX_TICK);

/** Greatest tick whose sqrt ratio is <= the argument. Deterministic binary search over the tick range. */
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 > MAX_SQRT_RATIO)
    throw new RangeError('sqrt price is outside the tick range');
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (sqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function sorted(a: bigint, b: bigint): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

/** Token0 needed to move between two sqrt prices at liquidity L. Mirrors the v3 rounding order exactly. */
export function amount0Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  rounding: Directed,
): bigint {
  const [lo, hi] = sorted(sqrtA, sqrtB);
  if (lo <= 0n) throw new RangeError('sqrt price must be positive');
  if (liquidity < 0n) throw new RangeError('liquidity must be non-negative');
  const numerator = liquidity << 96n;
  const inner = mulDiv(numerator, hi - lo, hi, rounding);
  return mulDiv(inner, 1n, lo, rounding);
}

/** Token1 needed to move between two sqrt prices at liquidity L. */
export function amount1Delta(
  sqrtA: bigint,
  sqrtB: bigint,
  liquidity: bigint,
  rounding: Directed,
): bigint {
  const [lo, hi] = sorted(sqrtA, sqrtB);
  if (liquidity < 0n) throw new RangeError('liquidity must be non-negative');
  return mulDiv(liquidity, hi - lo, Q96, rounding);
}

export type RangeState = 'below' | 'in-range' | 'above';

export interface PositionShape {
  readonly sqrtLower: bigint;
  readonly sqrtUpper: bigint;
  readonly liquidity: bigint;
}

export function assertRange(sqrtLower: bigint, sqrtUpper: bigint): void {
  if (sqrtLower <= 0n || sqrtLower >= sqrtUpper)
    throw new RangeError('range requires 0 < sqrtLower < sqrtUpper');
}

/**
 * Price relative to the range. A position earns fees only when `in-range`.
 * `sqrtLower <= price < sqrtUpper` is in range (the lower bound is inclusive, as in v3).
 */
export function rangeState(sqrtPrice: bigint, sqrtLower: bigint, sqrtUpper: bigint): RangeState {
  assertRange(sqrtLower, sqrtUpper);
  if (sqrtPrice < sqrtLower) return 'below';
  if (sqrtPrice >= sqrtUpper) return 'above';
  return 'in-range';
}

export interface Amounts {
  readonly amount0: bigint;
  readonly amount1: bigint;
}

/**
 * Token amounts represented by `liquidity` at `sqrtPrice`. `rounding: 'floor'` = what a withdrawal can pay out;
 * `'ceil'` = what a deposit must supply.
 */
export function amountsForLiquidity(
  sqrtPrice: bigint,
  shape: PositionShape,
  rounding: Directed,
): Amounts & { state: RangeState } {
  const { sqrtLower, sqrtUpper, liquidity } = shape;
  assertRange(sqrtLower, sqrtUpper);
  const state = rangeState(sqrtPrice, sqrtLower, sqrtUpper);
  if (state === 'below')
    return { amount0: amount0Delta(sqrtLower, sqrtUpper, liquidity, rounding), amount1: 0n, state };
  if (state === 'above')
    return { amount0: 0n, amount1: amount1Delta(sqrtLower, sqrtUpper, liquidity, rounding), state };
  return {
    amount0: amount0Delta(sqrtPrice, sqrtUpper, liquidity, rounding),
    amount1: amount1Delta(sqrtLower, sqrtPrice, liquidity, rounding),
    state,
  };
}

function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const [lo, hi] = sorted(sqrtA, sqrtB);
  const intermediate = mulDiv(lo, hi, Q96);
  return mulDiv(amount0, intermediate, hi - lo);
}

function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const [lo, hi] = sorted(sqrtA, sqrtB);
  return mulDiv(amount1, Q96, hi - lo);
}

/** Largest liquidity (rounded down) that the given token amounts can fund at `sqrtPrice`. */
export function liquidityForAmounts(args: {
  sqrtPrice: bigint;
  sqrtLower: bigint;
  sqrtUpper: bigint;
  amount0: bigint;
  amount1: bigint;
}): bigint {
  const { sqrtPrice, sqrtLower, sqrtUpper, amount0, amount1 } = args;
  assertRange(sqrtLower, sqrtUpper);
  if (amount0 < 0n || amount1 < 0n) throw new RangeError('amounts must be non-negative');
  if (sqrtPrice <= sqrtLower) return liquidityForAmount0(sqrtLower, sqrtUpper, amount0); // price == lower holds only token0 (as in Uniswap LiquidityAmounts); also avoids a zero divisor below
  if (sqrtPrice >= sqrtUpper) return liquidityForAmount1(sqrtLower, sqrtUpper, amount1);
  const l0 = liquidityForAmount0(sqrtPrice, sqrtUpper, amount0);
  const l1 = liquidityForAmount1(sqrtLower, sqrtPrice, amount1);
  return l0 < l1 ? l0 : l1;
}

/** token0 -> token1 value at `sqrtPrice`: amount0 * P with P = sqrtPrice^2 / 2^192. Single rounding step. */
export function token0ValueInToken1(
  amount0: bigint,
  sqrtPrice: bigint,
  rounding: Directed,
): bigint {
  if (amount0 < 0n) throw new RangeError('amount must be non-negative');
  return mulDiv(amount0, sqrtPrice * sqrtPrice, Q192, rounding);
}

/** token1 -> token0 value at `sqrtPrice`: amount1 / P. */
export function token1ValueInToken0(
  amount1: bigint,
  sqrtPrice: bigint,
  rounding: Directed,
): bigint {
  if (amount1 < 0n) throw new RangeError('amount must be non-negative');
  if (sqrtPrice <= 0n) throw new RangeError('sqrt price must be positive');
  return mulDiv(amount1, Q192, sqrtPrice * sqrtPrice, rounding);
}

/** Value of a bundle of token amounts, in token1 raw units, at `sqrtPrice`. */
export function valueInToken1(amounts: Amounts, sqrtPrice: bigint, rounding: Directed): bigint {
  return amounts.amount1 + token0ValueInToken1(amounts.amount0, sqrtPrice, rounding);
}

/** Mark-to-market value of a position in token1 raw units (rounds down: never overstates what can be withdrawn). */
export function positionValueInToken1(sqrtPrice: bigint, shape: PositionShape): bigint {
  return valueInToken1(amountsForLiquidity(sqrtPrice, shape, 'floor'), sqrtPrice, 'floor');
}

/** (a - b) modulo 2^256, as the on-chain `unchecked` fee-growth arithmetic does. */
export function subMod256(a: bigint, b: bigint): bigint {
  return (((a - b) % U256_MOD) + U256_MOD) % U256_MOD;
}

/**
 * Fee growth inside a tick range, from the pool's global and per-tick "outside" accumulators (Q128 per unit of
 * liquidity). Pure transcription of the standard v3 accounting identity:
 *   inside = global - below - above, where below/above depend on where the current tick sits.
 */
export function feeGrowthInsideX128(args: {
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  feeGrowthGlobalX128: bigint;
  feeGrowthOutsideLowerX128: bigint;
  feeGrowthOutsideUpperX128: bigint;
}): bigint {
  const {
    tickLower,
    tickUpper,
    tickCurrent,
    feeGrowthGlobalX128: g,
    feeGrowthOutsideLowerX128: lo,
    feeGrowthOutsideUpperX128: up,
  } = args;
  if (tickLower >= tickUpper) throw new RangeError('tickLower must be below tickUpper');
  const below = tickCurrent >= tickLower ? lo : subMod256(g, lo);
  const above = tickCurrent < tickUpper ? up : subMod256(g, up);
  return subMod256(subMod256(g, below), above);
}

/**
 * Fees accrued to a position since its last checkpoint, in the token's raw units (rounded down).
 * This is protocol accounting, so the amount is REALIZED (earned and claimable), whether or not collected yet.
 */
export function feesOwed(args: {
  liquidity: bigint;
  feeGrowthInsideNowX128: bigint;
  feeGrowthInsideLastX128: bigint;
}): bigint {
  if (args.liquidity < 0n) throw new RangeError('liquidity must be non-negative');
  return mulDiv(
    subMod256(args.feeGrowthInsideNowX128, args.feeGrowthInsideLastX128),
    args.liquidity,
    Q128,
  );
}
