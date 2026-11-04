import {
  amountsForLiquidity,
  positionValueInToken1,
  token0ValueInToken1,
  valueInToken1,
  type PositionShape,
} from './clmm';
import { divRound, sqrtWad, WAD } from './fixed';

/**
 * Impermanent loss (IL): the mark-to-market difference between holding a liquidity position and simply holding
 * ("HODLing") the tokens that were deposited, EXCLUDING fees. It is a valuation, not a cash event: it becomes
 * realized only when the position is closed. Sign convention: IL <= 0 (a loss) or 0.
 */

/**
 * Full-range (constant product) IL as a function of the price ratio r = P_exit / P_entry (WAD):
 *     IL(r) = 2*sqrt(r) / (1 + r) - 1
 * Exact for x*y=k pools. Known values: r=1 -> 0, r=2 -> -5.7191%, r=4 -> -20% (exactly), r=1/4 -> -20% (exactly).
 * Result is WAD-scaled, rounded to nearest; square root rounds down (error < 10^-18).
 */
export function impermanentLossFullRangeWad(priceRatioWad: bigint): bigint {
  if (priceRatioWad <= 0n) throw new RangeError('price ratio must be positive');
  const root = sqrtWad(priceRatioWad);
  return divRound(2n * root * WAD, WAD + priceRatioWad, 'nearest') - WAD;
}

export interface ConcentratedIl {
  /** What was deposited at entry (rounded up: the real deposit). */
  readonly entryAmount0: bigint;
  readonly entryAmount1: bigint;
  /** Value at the exit price, token1 raw units. */
  readonly hodlValueToken1: bigint;
  readonly positionValueToken1: bigint;
  /** position - hodl, token1 raw units. Always <= 0 by construction of the rounding. */
  readonly ilToken1: bigint;
  /** ilToken1 / hodlValueToken1, WAD, rounded toward -infinity (never understates a loss). */
  readonly ilWad: bigint;
}

/**
 * IL of a concentrated position between `entrySqrtPrice` and `exitSqrtPrice` (fees excluded), all in token1 terms.
 *
 * Why IL <= 0 always: the position's value as a function of price is concave and equals the HODL line's slope at the
 * entry price (both hold `entryAmount0` of token0 there), so it lies on or below the HODL line. Rounding is chosen so
 * the computed result keeps that sign: the HODL basket rounds UP (deposits round up), the position value rounds DOWN.
 */
export function impermanentLossConcentrated(args: {
  shape: PositionShape;
  entrySqrtPrice: bigint;
  exitSqrtPrice: bigint;
}): ConcentratedIl {
  const { shape, entrySqrtPrice, exitSqrtPrice } = args;
  const deposit = amountsForLiquidity(entrySqrtPrice, shape, 'ceil');
  const hodl = valueInToken1(deposit, exitSqrtPrice, 'ceil');
  const position = positionValueInToken1(exitSqrtPrice, shape);
  if (hodl <= 0n) throw new RangeError('HODL value is zero; IL is undefined');
  const il = position - hodl;
  return {
    entryAmount0: deposit.amount0,
    entryAmount1: deposit.amount1,
    hodlValueToken1: hodl,
    positionValueToken1: position,
    ilToken1: il > 0n ? 0n : il,
    ilWad: divRound((il > 0n ? 0n : il) * WAD, hodl, 'floor'),
  };
}

/** Value (token1) of the original deposit basket if it had simply been held, at `sqrtPrice`. Rounds down. */
export function hodlValueToken1(
  entryAmount0: bigint,
  entryAmount1: bigint,
  sqrtPrice: bigint,
): bigint {
  return entryAmount1 + token0ValueInToken1(entryAmount0, sqrtPrice, 'floor');
}
