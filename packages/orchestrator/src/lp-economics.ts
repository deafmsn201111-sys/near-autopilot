import {
  MAX_TICK,
  MIN_TICK,
  amountsForLiquidity,
  estimateFeeApr,
  paybackDays,
  rangeState,
  rebalanceCost,
  sqrtRatioAtTick,
  valueInToken1,
} from '@near-autopilot/financial-engine';
import type { OrchestratorConfig } from './config';
import type { LpPositionView } from './types';

export type LpEvaluation =
  | {
      readonly ok: true;
      readonly costQuote: bigint;
      readonly extraFeesPerDayQuote: bigint;
      readonly paybackDays: bigint;
      readonly note: string;
    }
  | {
      readonly ok: false;
      readonly code: 'INVALID_RANGE' | 'LP_NOT_WORTH_IT';
      readonly detail: string;
    };

/**
 * Is moving this position to [tickLower, tickUpper] worth its cost? Used by the LP Optimizer to decide whether to
 * propose and by the decision engine to re-check anyone else's proposal with the same arithmetic, so a proposal's
 * claimed benefit is never taken on trust.
 *
 * ESTIMATE. Fees come from `estimateFeeApr` (yesterday's volume, spread pro rata over active liquidity, times an
 * assumed time-in-range); cost is `rebalanceCost` against the supplied order book at the pre-trade spot price. The
 * comparison is in the pool's quote token. Tick -> price uses `sqrtRatioAtTick`, which is not bit-identical to
 * Uniswap's table (see docs/financial-engine.md); a recommendation here is advice for a human, not an input to a
 * transaction.
 */
export function evaluateLpReposition(
  view: LpPositionView,
  tickLower: number,
  tickUpper: number,
  config: OrchestratorConfig,
): LpEvaluation {
  if (
    !Number.isInteger(tickLower) ||
    !Number.isInteger(tickUpper) ||
    tickLower < MIN_TICK ||
    tickUpper > MAX_TICK ||
    tickLower >= tickUpper
  ) {
    return {
      ok: false,
      code: 'INVALID_RANGE',
      detail: `ticks [${tickLower}, ${tickUpper}] are not a valid range`,
    };
  }
  if (tickUpper - tickLower < 2)
    return { ok: false, code: 'INVALID_RANGE', detail: 'range is narrower than 2 ticks' };

  const current = amountsForLiquidity(view.sqrtPrice, view.range, 'floor');
  const capitalQuote = valueInToken1(current, view.sqrtPrice, 'floor');
  if (capitalQuote <= 0n)
    return { ok: false, code: 'LP_NOT_WORTH_IT', detail: 'position has no value' };

  const newLower = sqrtRatioAtTick(tickLower);
  const newUpper = sqrtRatioAtTick(tickUpper);
  let cost;
  try {
    cost = rebalanceCost({
      holdings0: current.amount0,
      holdings1: current.amount1,
      sqrtPrice: view.sqrtPrice,
      newLower,
      newUpper,
      segments: view.segments,
      feePpm: view.feePpm,
      gasQuote: view.gasQuote,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'LP_NOT_WORTH_IT',
      detail: `cannot cost the move: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const inRange =
    rangeState(view.sqrtPrice, view.range.sqrtLower, view.range.sqrtUpper) === 'in-range';
  const assumed = config.lp.assumedTimeInRangeBps;
  const currentFees = inRange
    ? estimateFeeApr({
        capitalQuote,
        volume24hQuote: view.volume24hQuote,
        feePpm: view.feePpm,
        positionLiquidity: view.range.liquidity,
        activePoolLiquidity: view.activePoolLiquidity,
        activeLiquidityIncludesPosition: view.activeIncludesPosition,
        timeInRangeBps: assumed,
      }).feesPerDayQuote
    : 0n;

  // The pool the new position would join no longer contains the old one if that was in range.
  const othersLiquidity =
    inRange && view.activeIncludesPosition
      ? view.activePoolLiquidity - view.range.liquidity
      : view.activePoolLiquidity;
  const afterValue = valueInToken1(cost.solution.deposited, view.sqrtPrice, 'floor');
  if (afterValue <= 0n || cost.solution.liquidity <= 0n)
    return { ok: false, code: 'LP_NOT_WORTH_IT', detail: 'new range would hold nothing' };
  const newFees = estimateFeeApr({
    capitalQuote: afterValue,
    volume24hQuote: view.volume24hQuote,
    feePpm: view.feePpm,
    positionLiquidity: cost.solution.liquidity,
    activePoolLiquidity: othersLiquidity,
    activeLiquidityIncludesPosition: false,
    timeInRangeBps: assumed,
  }).feesPerDayQuote;

  const extra = newFees - currentFees;
  if (extra <= 0n)
    return { ok: false, code: 'LP_NOT_WORTH_IT', detail: 'estimated fees do not improve' };
  const payback = paybackDays({
    costQuote: cost.totalCostQuote,
    estimatedFeesPerDayQuote: extra,
  }).days;
  if (payback === null || payback > BigInt(config.lp.maxPaybackDays)) {
    return {
      ok: false,
      code: 'LP_NOT_WORTH_IT',
      detail: `estimated payback ${payback ?? 'never'} days exceeds ${config.lp.maxPaybackDays}`,
    };
  }
  return {
    ok: true,
    costQuote: cost.totalCostQuote,
    extraFeesPerDayQuote: extra,
    paybackDays: payback,
    note: 'ESTIMATE: assumes volume persists and a fixed time-in-range; excludes IL, MEV and the cost of being out of range while waiting',
  };
}
