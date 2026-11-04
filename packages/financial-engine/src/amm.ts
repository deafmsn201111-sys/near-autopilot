import { amount0Delta, amount1Delta } from './clmm';
import { BPS, divRound, mulDiv, PPM, Q96, WAD, type Directed } from './fixed';

/**
 * Swap quoting and slippage, exact integer arithmetic.
 *
 *  - Constant-product (x*y=k) pools, with a proportional input fee.
 *  - Concentrated-liquidity pools: the standard step-wise swap over liquidity segments (same step arithmetic as the
 *    v3 reference, including its rounding: input rounds up, output rounds down, fee takes the remainder).
 *
 * Slippage vocabulary used throughout (all in bps, all rounded UP so a cost is never understated):
 *   priceImpactBps  how far the trade itself moved the price (fee excluded)
 *   feeBps          the pool fee actually paid
 *   totalCostBps    1 - (output received / output at the pre-trade spot price)   -- impact + fee, with rounding
 *   slippage vs a QUOTE is a separate concept: `minAmountOut` in swap.ts applies a tolerance to a quoted output.
 */

function assertFee(feePpm: number): void {
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1_000_000)
    throw new RangeError(`feePpm must be an integer in [0, 999999], got ${feePpm}`);
}

export interface SwapCost {
  /** Pool fee paid, in input-token raw units (rounded up). */
  readonly feeAmount: bigint;
  /** 1 - out_without_fee/out_at_spot, bps, rounded up. */
  readonly priceImpactBps: bigint;
  /** 1 - out/out_at_spot, bps, rounded up. */
  readonly totalCostBps: bigint;
}

export interface ConstantProductQuote extends SwapCost {
  readonly amountOut: bigint;
  /** Marginal (spot) price before the trade, output raw units per input raw unit, WAD. */
  readonly spotPriceWad: bigint;
  /** amountOut/amountIn, WAD (rounds down). */
  readonly executionPriceWad: bigint;
  readonly reserveInAfter: bigint;
  readonly reserveOutAfter: bigint;
}

/** Exact-in quote on an x*y=k pool. The fee is charged on the input and stays in the pool. */
export function constantProductQuote(args: {
  reserveIn: bigint;
  reserveOut: bigint;
  amountIn: bigint;
  feePpm: number;
}): ConstantProductQuote {
  const { reserveIn, reserveOut, amountIn, feePpm } = args;
  assertFee(feePpm);
  if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError('reserves must be positive');
  if (amountIn <= 0n) throw new RangeError('amountIn must be positive');

  const inAfterFee = amountIn * (PPM - BigInt(feePpm));
  const amountOut = mulDiv(inAfterFee, reserveOut, reserveIn * PPM + inAfterFee, 'floor');
  const feeAmount = mulDiv(amountIn, BigInt(feePpm), PPM, 'ceil');

  // Reference outputs at the pre-trade marginal price, as exact rationals scaled by `reserveIn`.
  const outAtSpot = mulDiv(amountIn, reserveOut, reserveIn, 'floor');
  const outNoFee = mulDiv(amountIn, reserveOut, reserveIn + amountIn, 'floor'); // zero-fee execution
  const toBps = (reference: bigint, actual: bigint): bigint =>
    reference <= 0n ? 0n : divRound((reference - actual) * BPS, reference, 'ceil');

  return {
    amountOut,
    feeAmount,
    spotPriceWad: mulDiv(reserveOut, WAD, reserveIn, 'floor'),
    executionPriceWad: mulDiv(amountOut, WAD, amountIn, 'floor'),
    priceImpactBps: toBps(outAtSpot, outNoFee),
    totalCostBps: toBps(outAtSpot, amountOut),
    reserveInAfter: reserveIn + amountIn,
    reserveOutAfter: reserveOut - amountOut,
  };
}

/** Smallest input that yields at least `amountOut` (rounds up). Throws if the pool cannot supply it. */
export function constantProductAmountIn(args: {
  reserveIn: bigint;
  reserveOut: bigint;
  amountOut: bigint;
  feePpm: number;
}): bigint {
  const { reserveIn, reserveOut, amountOut, feePpm } = args;
  assertFee(feePpm);
  if (amountOut <= 0n) throw new RangeError('amountOut must be positive');
  if (amountOut >= reserveOut) throw new RangeError('pool cannot supply that output');
  return mulDiv(
    reserveIn * amountOut * PPM,
    1n,
    (reserveOut - amountOut) * (PPM - BigInt(feePpm)),
    'ceil',
  );
}

// ----------------------------------------------------------------------------------------------------------
// Concentrated liquidity
// ----------------------------------------------------------------------------------------------------------

/** Contiguous slice of price space with constant active liquidity. Zero-liquidity gaps are explicit segments. */
export interface LiquiditySegment {
  readonly sqrtLower: bigint;
  readonly sqrtUpper: bigint;
  readonly liquidity: bigint;
}

function nextSqrtPriceFromInput(
  sqrtP: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
): bigint {
  if (amountIn === 0n) return sqrtP;
  if (liquidity <= 0n) throw new RangeError('liquidity must be positive to move the price');
  if (zeroForOne) {
    const numerator = liquidity << 96n;
    return mulDiv(numerator, sqrtP, numerator + amountIn * sqrtP, 'ceil'); // price moves down; round up (toward start)
  }
  return sqrtP + mulDiv(amountIn, Q96, liquidity, 'floor'); // price moves up; round down (toward start)
}

export interface SwapStep {
  readonly sqrtPriceNext: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly feeAmount: bigint;
}

/** One exact-in step toward `sqrtTarget` inside a single constant-liquidity segment. */
export function swapStepExactIn(args: {
  sqrtCurrent: bigint;
  sqrtTarget: bigint;
  liquidity: bigint;
  amountRemaining: bigint;
  feePpm: number;
}): SwapStep {
  const { sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePpm } = args;
  assertFee(feePpm);
  const zeroForOne = sqrtCurrent >= sqrtTarget;
  const fee = BigInt(feePpm);
  const remainingLessFee = mulDiv(amountRemaining, PPM - fee, PPM, 'floor');

  const inToTarget = zeroForOne
    ? amount0Delta(sqrtTarget, sqrtCurrent, liquidity, 'ceil')
    : amount1Delta(sqrtCurrent, sqrtTarget, liquidity, 'ceil');

  const reachedTarget = remainingLessFee >= inToTarget;
  const sqrtPriceNext = reachedTarget
    ? sqrtTarget
    : nextSqrtPriceFromInput(sqrtCurrent, liquidity, remainingLessFee, zeroForOne);

  const amountIn = reachedTarget
    ? inToTarget
    : zeroForOne
      ? amount0Delta(sqrtPriceNext, sqrtCurrent, liquidity, 'ceil')
      : amount1Delta(sqrtCurrent, sqrtPriceNext, liquidity, 'ceil');
  const amountOut = zeroForOne
    ? amount1Delta(sqrtPriceNext, sqrtCurrent, liquidity, 'floor')
    : amount0Delta(sqrtCurrent, sqrtPriceNext, liquidity, 'floor');
  const feeAmount = reachedTarget
    ? mulDiv(amountIn, fee, PPM - fee, 'ceil')
    : amountRemaining - amountIn;
  return { sqrtPriceNext, amountIn, amountOut, feeAmount };
}

export interface ConcentratedQuote extends SwapCost {
  readonly zeroForOne: boolean;
  /** Input actually consumed (including fees). Less than requested when `exhausted`. */
  readonly amountInConsumed: bigint;
  readonly amountOut: bigint;
  readonly sqrtPriceBefore: bigint;
  readonly sqrtPriceAfter: bigint;
  /** True if the supplied segments ran out (or the limit was hit) before the input was used up. */
  readonly exhausted: boolean;
  readonly amountRemaining: bigint;
}

function validateSegments(segments: readonly LiquiditySegment[]): void {
  if (segments.length === 0) throw new RangeError('at least one liquidity segment is required');
  for (const [i, s] of segments.entries()) {
    if (s.sqrtLower <= 0n || s.sqrtLower >= s.sqrtUpper)
      throw new RangeError(`segment ${i}: requires 0 < sqrtLower < sqrtUpper`);
    if (s.liquidity < 0n) throw new RangeError(`segment ${i}: negative liquidity`);
    const prev = segments[i - 1];
    if (prev && prev.sqrtUpper !== s.sqrtLower)
      throw new RangeError(`segment ${i}: not contiguous with the previous segment`);
  }
}

/**
 * Exact-in quote that walks liquidity segments (sorted ascending, contiguous). Direction convention: price falls for
 * token0-in (`zeroForOne`) and rises for token1-in, and a price sitting exactly on a boundary belongs to the
 * segment it is about to enter. The caller supplies depth; the engine never guesses missing liquidity.
 */
export function concentratedQuoteExactIn(args: {
  sqrtPrice: bigint;
  segments: readonly LiquiditySegment[];
  zeroForOne: boolean;
  amountIn: bigint;
  feePpm: number;
  sqrtPriceLimit?: bigint;
}): ConcentratedQuote {
  const { sqrtPrice, segments, zeroForOne, amountIn, feePpm } = args;
  assertFee(feePpm);
  validateSegments(segments);
  if (amountIn <= 0n) throw new RangeError('amountIn must be positive');
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (sqrtPrice < first.sqrtLower || sqrtPrice > last.sqrtUpper)
    throw new RangeError('price is outside the supplied segments');
  const limit = args.sqrtPriceLimit ?? (zeroForOne ? first.sqrtLower : last.sqrtUpper);
  if (zeroForOne ? limit >= sqrtPrice : limit <= sqrtPrice)
    throw new RangeError('price limit is on the wrong side of the current price');

  let current = sqrtPrice;
  let remaining = amountIn;
  let out = 0n;
  let feeTotal = 0n;

  while (remaining > 0n && (zeroForOne ? current > limit : current < limit)) {
    const seg = zeroForOne
      ? segments.find((s) => s.sqrtLower < current && current <= s.sqrtUpper)
      : segments.find((s) => s.sqrtLower <= current && current < s.sqrtUpper);
    if (!seg) break;
    const boundary = zeroForOne ? seg.sqrtLower : seg.sqrtUpper;
    const target = zeroForOne
      ? boundary > limit
        ? boundary
        : limit
      : boundary < limit
        ? boundary
        : limit;
    const step = swapStepExactIn({
      sqrtCurrent: current,
      sqrtTarget: target,
      liquidity: seg.liquidity,
      amountRemaining: remaining,
      feePpm,
    });
    remaining -= step.amountIn + step.feeAmount;
    out += step.amountOut;
    feeTotal += step.feeAmount;
    current = step.sqrtPriceNext;
  }

  const consumed = amountIn - remaining;
  // Reference outputs at the pre-trade spot price. P = sqrt^2 / 2^192; token0->token1 multiplies, token1->token0 divides.
  const p2 = sqrtPrice * sqrtPrice;
  const outAtSpot = zeroForOne
    ? mulDiv(consumed, p2, 1n << 192n, 'floor')
    : mulDiv(consumed, 1n << 192n, p2, 'floor');
  const inNoFee = consumed - feeTotal;
  const outNoFeeRef = zeroForOne
    ? mulDiv(inNoFee, p2, 1n << 192n, 'floor')
    : mulDiv(inNoFee, 1n << 192n, p2, 'floor');
  const toBps = (reference: bigint, actual: bigint): bigint =>
    reference <= 0n
      ? 0n
      : divRound((reference > actual ? reference - actual : 0n) * BPS, reference, 'ceil');

  return {
    zeroForOne,
    amountInConsumed: consumed,
    amountOut: out,
    sqrtPriceBefore: sqrtPrice,
    sqrtPriceAfter: current,
    exhausted: remaining > 0n,
    amountRemaining: remaining,
    feeAmount: feeTotal,
    // Impact measures pure price movement: compare output at spot of the fee-net input with the actual output.
    priceImpactBps: toBps(outNoFeeRef, out),
    totalCostBps: toBps(outAtSpot, out),
  };
}

/** True when `actualOut` is at least `quotedOut` minus a `toleranceBps` allowance (integer, rounds the floor down). */
export function withinSlippage(args: {
  quotedOut: bigint;
  actualOut: bigint;
  toleranceBps: number;
}): boolean {
  if (!Number.isInteger(args.toleranceBps) || args.toleranceBps < 0 || args.toleranceBps > 10_000)
    throw new RangeError('toleranceBps must be in [0, 10000]');
  const floor = (args.quotedOut * (BPS - BigInt(args.toleranceBps))) / BPS;
  return args.actualOut >= floor;
}

export type { Directed };
