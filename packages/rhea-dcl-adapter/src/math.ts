import { POINT_MAX, POINT_MIN, feeToPointDelta } from './constants';
import { SQRT_PRICE_INIT_EVEN, SQRT_PRICE_INIT_ODD, SQRT_PRICE_STEPS } from './sqrt-table';

/**
 * Exact integer tick/liquidity math, ported from ref-finance/ref-ui src/services/compute_liquidity.ts
 * (tier A). The frontend uses it to size deposits before calling `add_liquidity`, so it mirrors the
 * contract's own arithmetic. Everything is bigint; nothing here touches floating point except the
 * explicitly named display helpers.
 *
 * Model (iZiSwap-style discretised concentrated liquidity):
 *   - price at integer `point` p:  undecimalPrice = 1.0001^p  = rawY per rawX
 *   - a position covers the half-open range [leftPoint, rightPoint)
 *   - `sqrtPriceX96(p)` is sqrt(1.0001^p) * 2^96, rounded up
 */

export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const U256_MAX = (1n << 256n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/** sqrt(1.0001^point) * 2^96, ceil. Throws outside [POINT_MIN, POINT_MAX] (the frontend returns 0 instead). */
export function sqrtPriceX96(point: number): bigint {
  assertPoint(point);
  const abs = Math.abs(point);
  let value = (point & 1) !== 0 ? SQRT_PRICE_INIT_ODD : SQRT_PRICE_INIT_EVEN;
  for (const [mask, multiplier] of SQRT_PRICE_STEPS) {
    if ((abs & mask) !== 0) value = (value * multiplier) / Q128;
  }
  if (point > 0) value = U256_MAX / value;
  // >> 32, rounding up
  const shifted = value >> 32n;
  return (value & 0xffff_ffffn) > 0n ? shifted + 1n : shifted;
}

/** sqrt(1.0001) * 2^96. */
export const SQRT_RATE_X96 = sqrtPriceX96(1);

export function assertPoint(point: number): void {
  if (!Number.isInteger(point) || point < POINT_MIN || point > POINT_MAX) {
    throw new RangeError(
      `Point ${point} is outside [${POINT_MIN}, ${POINT_MAX}] or not an integer`,
    );
  }
}

/** Floor toward -infinity to a multiple of `pointDelta` (matches ref-sdk getPointByPrice). */
export function floorToPointDelta(point: number, pointDelta: number): number {
  return Math.floor(point / pointDelta) * pointDelta;
}

export function isAlignedToPointDelta(point: number, pointDelta: number): boolean {
  return Number.isInteger(point) && point % pointDelta === 0;
}

/** Validates a liquidity range the way the frontend constructs it (snapped to the pool's point delta). */
export function assertValidRange(leftPoint: number, rightPoint: number, pointDelta: number): void {
  assertPoint(leftPoint);
  assertPoint(rightPoint);
  if (leftPoint >= rightPoint)
    throw new RangeError(`leftPoint ${leftPoint} must be < rightPoint ${rightPoint}`);
  if (
    !isAlignedToPointDelta(leftPoint, pointDelta) ||
    !isAlignedToPointDelta(rightPoint, pointDelta)
  ) {
    throw new RangeError(
      `Range [${leftPoint}, ${rightPoint}) must be multiples of point delta ${pointDelta}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Display-only price helpers (floating point; never use for amounts)
// ---------------------------------------------------------------------------------------------

const LN_1_0001 = Math.log(1.0001);

/** rawY per rawX at `point`. Display only. */
export function pointToUndecimalPrice(point: number): number {
  assertPoint(point);
  return Math.pow(1.0001, point);
}

/** Human price of X denominated in Y: undecimal * 10^(decimalsX - decimalsY). Display only. */
export function pointToDecimalPrice(point: number, decimalsX: number, decimalsY: number): number {
  return pointToUndecimalPrice(point) * Math.pow(10, decimalsX - decimalsY);
}

/**
 * Human price of X denominated in Y -> pool point, snapped DOWN to the pool's point delta and clamped
 * to the legal range. Same algorithm as ref-sdk `priceToPoint` (round, then floor to delta).
 */
export function decimalPriceToPoint(args: {
  readonly priceYPerX: number;
  readonly decimalsX: number;
  readonly decimalsY: number;
  readonly fee: number;
}): number {
  const { priceYPerX, decimalsX, decimalsY } = args;
  if (!(priceYPerX > 0) || !Number.isFinite(priceYPerX))
    throw new RangeError('price must be a positive finite number');
  const undecimal = priceYPerX * Math.pow(10, decimalsY - decimalsX);
  const raw = Math.round(Math.log(undecimal) / LN_1_0001);
  const snapped = floorToPointDelta(raw, feeToPointDelta(args.fee));
  return Math.min(POINT_MAX, Math.max(POINT_MIN, snapped));
}

// ---------------------------------------------------------------------------------------------
// Liquidity <-> token amounts
// ---------------------------------------------------------------------------------------------

function mulFractionFloor(n: bigint, numerator: bigint, denominator: bigint): bigint {
  return (n * numerator) / denominator;
}

function mulFractionCeil(n: bigint, numerator: bigint, denominator: bigint): bigint {
  const product = n * numerator;
  const q = product / denominator;
  return product % denominator === 0n ? q : q + 1n;
}

function amountYPerUnitX96(sqrtPriceLX96: bigint, sqrtPriceRX96: bigint): bigint {
  return mulFractionCeil(Q96, sqrtPriceRX96 - sqrtPriceLX96, SQRT_RATE_X96 - Q96);
}

function amountXPerUnitX96(leftPoint: number, rightPoint: number, sqrtPriceRX96: bigint): bigint {
  const pr_pc = sqrtPriceX96(rightPoint - leftPoint + 1);
  const pr_pd = sqrtPriceX96(rightPoint + 1);
  return mulFractionCeil(Q96, pr_pc - SQRT_RATE_X96, pr_pd - sqrtPriceRX96);
}

/**
 * Token X / token Y (raw units, scaled by 2^96) required per ONE unit of liquidity in
 * [leftPoint, rightPoint) when the pool sits at `currentPoint`. Port of `compute_deposit_xy_per_unit`.
 */
export function depositPerUnitLiquidityX96(
  leftPoint: number,
  rightPoint: number,
  currentPoint: number,
): { readonly x: bigint; readonly y: bigint } {
  const sqrtCurrent = sqrtPriceX96(currentPoint);
  const sqrtRight = sqrtPriceX96(rightPoint);
  let y = 0n;
  if (leftPoint < currentPoint) {
    const sqrtLeft = sqrtPriceX96(leftPoint);
    y = amountYPerUnitX96(sqrtLeft, rightPoint < currentPoint ? sqrtRight : sqrtCurrent);
  }
  let x = 0n;
  if (rightPoint > currentPoint) {
    const xLeft = leftPoint > currentPoint ? leftPoint : currentPoint + 1;
    x = amountXPerUnitX96(xLeft, rightPoint, sqrtRight);
    if (leftPoint <= currentPoint) y += sqrtCurrent;
  }
  return { x, y };
}

/**
 * Maximum liquidity fundable with the given raw amounts. Port of `compute_liquidity`.
 *
 * Deviation from the frontend (documented): the frontend computes `(amountY - 1)` unguarded, which is
 * negative for `amountY = 0`; here the result is clamped at 0 so a range that needs token Y but is given
 * none yields 0 liquidity rather than a negative bigint.
 */
export function computeLiquidity(args: {
  readonly leftPoint: number;
  readonly rightPoint: number;
  readonly currentPoint: number;
  readonly amountX: bigint;
  readonly amountY: bigint;
}): bigint {
  const { leftPoint, rightPoint, currentPoint, amountX, amountY } = args;
  if (amountX < 0n || amountY < 0n) throw new RangeError('amounts must be non-negative');
  assertPoint(leftPoint);
  assertPoint(rightPoint);
  assertPoint(currentPoint);
  let liquidity = U128_MAX / 2n;
  const per = depositPerUnitLiquidityX96(leftPoint, rightPoint, currentPoint);
  if (per.x > 0n) {
    const byX = mulFractionFloor(amountX, Q96, per.x);
    if (byX < liquidity) liquidity = byX;
  }
  if (per.y > 0n) {
    const byY = amountY === 0n ? 0n : mulFractionFloor(amountY - 1n, Q96, per.y);
    if (byY < liquidity) liquidity = byY;
  }
  return liquidity;
}

/**
 * Raw token amounts needed to mint `liquidity` in the range (ceil on both sides). This is the DEPOSIT
 * side of the arithmetic; the contract's withdrawal-side rounding was not readable in source, so when
 * used to value an existing position treat it as an estimate that can differ by a few raw units.
 */
export function requiredDepositForLiquidity(args: {
  readonly liquidity: bigint;
  readonly leftPoint: number;
  readonly rightPoint: number;
  readonly currentPoint: number;
}): { readonly x: bigint; readonly y: bigint } {
  if (args.liquidity < 0n) throw new RangeError('liquidity must be non-negative');
  const per = depositPerUnitLiquidityX96(args.leftPoint, args.rightPoint, args.currentPoint);
  return {
    x: per.x === 0n ? 0n : mulFractionCeil(args.liquidity, per.x, Q96),
    y: per.y === 0n ? 0n : mulFractionCeil(args.liquidity, per.y, Q96),
  };
}
