import {
  amountsForLiquidity,
  liquidityForAmounts,
  token0ValueInToken1,
  valueInToken1,
  type Amounts,
} from './clmm';
import { concentratedQuoteExactIn, type ConcentratedQuote, type LiquiditySegment } from './amm';
import { BPS, divRound } from './fixed';

/**
 * Rebalance cost for a concentrated-liquidity position that is closed and reopened on a new range.
 *
 * Steps modelled: (1) withdraw -> holdings (h0, h1); (2) swap just enough to match the new range's token ratio;
 * (3) deposit the maximum liquidity the post-swap holdings fund; leftover dust stays in the wallet.
 *
 * Cost accounting (all in token1 raw units, ALL measured at the PRE-TRADE spot price so market movement is not
 * counted as a cost):
 *     swapCost = value(holdings before) - value(holdings after the swap)      = pool fee + price impact (+ rounding)
 *     total    = swapCost + gas
 * Not included (and why): the IL crystallized by closing the old position (a valuation already visible in the IL
 * figure, not an extra cost), protocol withdrawal/deposit fees (protocol-specific, pass them in `otherCostQuote`),
 * MEV and failed-transaction gas, and post-swap price movement before the deposit lands.
 */

export interface RebalanceSwap {
  readonly zeroForOne: boolean;
  readonly quote: ConcentratedQuote;
}

export interface RebalanceSolution {
  /** null when no swap is needed (or possible/useful). */
  readonly swap: RebalanceSwap | null;
  readonly holdings0: bigint;
  readonly holdings1: bigint;
  readonly sqrtPriceAfterSwap: bigint;
  readonly liquidity: bigint;
  readonly deposited: Amounts;
  readonly leftover: Amounts;
}

type Side = 1 | 0 | -1;

/** +1: token0 is in surplus for the new range at this price, -1: token1 is, 0: balanced. */
function surplusSide(h0: bigint, h1: bigint, sqrtP: bigint, lower: bigint, upper: bigint): Side {
  const needs0 = sqrtP < upper;
  const needs1 = sqrtP > lower;
  if (!needs0) return h0 > 0n ? 1 : 0;
  if (!needs1) return h1 > 0n ? -1 : 0;
  const l0 = liquidityForAmounts({
    sqrtPrice: sqrtP,
    sqrtLower: lower,
    sqrtUpper: upper,
    amount0: h0,
    amount1: 1n << 250n,
  });
  const l1 = liquidityForAmounts({
    sqrtPrice: sqrtP,
    sqrtLower: lower,
    sqrtUpper: upper,
    amount0: 1n << 250n,
    amount1: h1,
  });
  return l0 > l1 ? 1 : l0 < l1 ? -1 : 0;
}

/**
 * Finds the swap that leaves the least unused value when depositing into [newLower, newUpper], by deterministic
 * bisection on the swap size (the surplus sign is monotone in the amount sold). At most ~200 quote evaluations.
 * Throws if the supplied liquidity segments cannot absorb the required swap.
 */
export function solveRebalance(args: {
  holdings0: bigint;
  holdings1: bigint;
  sqrtPrice: bigint;
  newLower: bigint;
  newUpper: bigint;
  segments: readonly LiquiditySegment[];
  feePpm: number;
}): RebalanceSolution {
  const { holdings0, holdings1, sqrtPrice, newLower, newUpper, segments, feePpm } = args;
  if (holdings0 < 0n || holdings1 < 0n) throw new RangeError('holdings must be non-negative');
  if (newLower <= 0n || newLower >= newUpper)
    throw new RangeError('range requires 0 < newLower < newUpper');

  const finish = (
    h0: bigint,
    h1: bigint,
    p: bigint,
    swap: RebalanceSwap | null,
  ): RebalanceSolution => {
    let liquidity = liquidityForAmounts({
      sqrtPrice: p,
      sqrtLower: newLower,
      sqrtUpper: newUpper,
      amount0: h0,
      amount1: h1,
    });
    let deposited = amountsForLiquidity(
      p,
      { sqrtLower: newLower, sqrtUpper: newUpper, liquidity },
      'ceil',
    );
    for (let i = 0; i < 16 && (deposited.amount0 > h0 || deposited.amount1 > h1); i += 1) {
      liquidity -= 1n; // nested floor/ceil rounding can overshoot a holding by one unit
      deposited = amountsForLiquidity(
        p,
        { sqrtLower: newLower, sqrtUpper: newUpper, liquidity },
        'ceil',
      );
    }
    if (deposited.amount0 > h0 || deposited.amount1 > h1)
      throw new RangeError('could not size a deposit within holdings');
    return {
      swap,
      holdings0: h0,
      holdings1: h1,
      sqrtPriceAfterSwap: p,
      liquidity,
      deposited,
      leftover: { amount0: h0 - deposited.amount0, amount1: h1 - deposited.amount1 },
    };
  };

  const direction = surplusSide(holdings0, holdings1, sqrtPrice, newLower, newUpper);
  if (direction === 0) return finish(holdings0, holdings1, sqrtPrice, null);
  const zeroForOne = direction === 1;
  const sellMax = zeroForOne ? holdings0 : holdings1;
  if (sellMax === 0n) return finish(holdings0, holdings1, sqrtPrice, null);

  const trial = (sell: bigint) => {
    const quote = concentratedQuoteExactIn({
      sqrtPrice,
      segments,
      zeroForOne,
      amountIn: sell,
      feePpm,
    });
    const h0 = zeroForOne ? holdings0 - quote.amountInConsumed : holdings0 + quote.amountOut;
    const h1 = zeroForOne ? holdings1 + quote.amountOut : holdings1 - quote.amountInConsumed;
    return { quote, h0, h1 };
  };
  // "Still selling too little": the sold token is still in surplus after the swap.
  const stillSurplus = (sell: bigint): boolean => {
    const t = trial(sell);
    if (t.quote.exhausted) return false; // too large for the available depth
    return surplusSide(t.h0, t.h1, t.quote.sqrtPriceAfter, newLower, newUpper) === direction;
  };

  let lo = 0n; // invariant: stillSurplus(lo) (true at 0 by construction)
  let hi = sellMax;
  if (stillSurplus(hi))
    lo = hi; // sell everything: the range is single-sided in the sold token's counterpart
  else {
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if (stillSurplus(mid)) lo = mid;
      else hi = mid;
    }
  }
  // `hi` is the smallest size at which the sold token is no longer in surplus OR the book ran dry. If it ran dry, the
  // depth (not the price) is what limits the swap and no honest balanced deposit exists.
  if (lo !== sellMax && trial(hi).quote.exhausted)
    throw new RangeError('supplied liquidity segments cannot absorb the swap needed to rebalance');
  const candidates = [lo, hi].filter((s) => s > 0n && s <= sellMax);
  let best: RebalanceSolution | null = null;
  for (const sell of candidates) {
    const t = trial(sell);
    if (t.quote.exhausted) continue;
    const candidate = finish(t.h0, t.h1, t.quote.sqrtPriceAfter, { zeroForOne, quote: t.quote });
    if (!best || candidate.liquidity > best.liquidity) best = candidate;
  }
  if (!best)
    throw new RangeError('supplied liquidity segments cannot absorb the swap needed to rebalance');
  return best;
}

export interface RebalanceCost {
  readonly solution: RebalanceSolution;
  /** Holdings valued at the pre-trade spot, token1 raw units (rounded down). */
  readonly valueBeforeQuote: bigint;
  /** Holdings after the swap valued at the SAME pre-trade spot (rounded down). */
  readonly valueAfterSwapAtSpotQuote: bigint;
  readonly poolFeeQuote: bigint;
  readonly priceImpactCostQuote: bigint;
  readonly swapCostQuote: bigint;
  readonly gasQuote: bigint;
  readonly otherCostQuote: bigint;
  readonly totalCostQuote: bigint;
  /** total / valueBefore, bps, rounded up. */
  readonly totalCostBps: bigint;
}

/** Full rebalance cost. `gasQuote` and `otherCostQuote` are caller-supplied, already converted to token1 units. */
export function rebalanceCost(args: {
  holdings0: bigint;
  holdings1: bigint;
  sqrtPrice: bigint;
  newLower: bigint;
  newUpper: bigint;
  segments: readonly LiquiditySegment[];
  feePpm: number;
  gasQuote: bigint;
  otherCostQuote?: bigint;
}): RebalanceCost {
  const other = args.otherCostQuote ?? 0n;
  if (args.gasQuote < 0n || other < 0n) throw new RangeError('costs must be non-negative');
  const solution = solveRebalance(args);
  const spot = args.sqrtPrice;
  const before = valueInToken1({ amount0: args.holdings0, amount1: args.holdings1 }, spot, 'floor');
  const afterSwap = valueInToken1(
    { amount0: solution.holdings0, amount1: solution.holdings1 },
    spot,
    'floor',
  );

  // Pool fee is paid in the input token; value it at spot (round up: costs are never understated).
  let poolFee = 0n;
  if (solution.swap) {
    const q = solution.swap.quote;
    poolFee = solution.swap.zeroForOne
      ? token0ValueInToken1(q.feeAmount, spot, 'ceil')
      : q.feeAmount;
  }
  const swapCost = before > afterSwap ? before - afterSwap : 0n;
  const priceImpactCost = swapCost > poolFee ? swapCost - poolFee : 0n;
  const total = swapCost + args.gasQuote + other;
  return {
    solution,
    valueBeforeQuote: before,
    valueAfterSwapAtSpotQuote: afterSwap,
    poolFeeQuote: poolFee > swapCost ? swapCost : poolFee,
    priceImpactCostQuote: priceImpactCost,
    swapCostQuote: swapCost,
    gasQuote: args.gasQuote,
    otherCostQuote: other,
    totalCostQuote: total,
    totalCostBps: before === 0n ? 0n : divRound(total * BPS, before, 'ceil'),
  };
}
