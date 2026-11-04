import {
  absBig,
  assertBps,
  BPS,
  divRound,
  mulDiv,
  powWad,
  PPM,
  SECONDS_PER_YEAR,
  WAD,
} from './fixed';

/**
 * Yield accounting that keeps three things apart. NEVER add numbers across bases.
 *
 *  realized   Cash events that already happened: fees collected (or irrevocably accrued to the position by protocol
 *             accounting), gas paid, swap costs paid. Observed, not modelled.
 *  marked     Deterministic mark-to-market of the current state at an observed price: uncollected fees and
 *             impermanent loss. Not cash yet, but no forecast is involved. Marked totals INCLUDE the realized ones.
 *  estimated  Anything that projects forward (fee APR from volume, projected costs). Depends on assumptions that
 *             are listed on the result. Estimated figures never feed realized or marked totals.
 *
 * Amounts are token raw units in ONE chosen quote token ("Quote"); the caller converts at one stated price.
 * Rates are WAD fractions (0.05 = 5%). Annualization is linear scaling by a 365-day year; it is arithmetic on an
 * observed rate, not a forecast, and results say so.
 */

export type YieldBasis = 'realized' | 'marked' | 'estimated';

export interface EstimatedFeeApr {
  readonly basis: 'estimated';
  readonly feesPerDayQuote: bigint;
  readonly capitalQuote: bigint;
  /** Simple annual rate: daily fees * 365 / capital. WAD, rounded down. */
  readonly aprWad: bigint;
  /** Compounded at `compoundingsPerYear`: (1 + apr/n)^n - 1. WAD. Assumes fees are reinvested at the same rate. */
  readonly apyWad: bigint;
  readonly assumptions: readonly string[];
}

/**
 * Forward-looking fee APR for a concentrated position. THIS IS AN ESTIMATE. Model:
 *     fees/day = volume24h * fee * share * timeInRange        share = L_pos / L_active
 * It assumes the last 24h of pool-wide volume repeats, that all of it trades against the active liquidity at the
 * current price, that liquidity depth stays as observed, and that the position stays in range for `timeInRangeBps`.
 */
export function estimateFeeApr(args: {
  capitalQuote: bigint;
  volume24hQuote: bigint;
  feePpm: number;
  positionLiquidity: bigint;
  /** Pool liquidity active at the current price. */
  activePoolLiquidity: bigint;
  /** True if `activePoolLiquidity` already contains the position (e.g. read after minting). */
  activeLiquidityIncludesPosition: boolean;
  /** Assumed fraction of time the position is in range, bps. */
  timeInRangeBps: number;
  compoundingsPerYear?: number;
}): EstimatedFeeApr {
  const { capitalQuote, volume24hQuote, feePpm, positionLiquidity, activePoolLiquidity } = args;
  assertBps(args.timeInRangeBps, 'timeInRangeBps');
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1_000_000)
    throw new RangeError('feePpm must be in [0, 999999]');
  if (capitalQuote <= 0n) throw new RangeError('capital must be positive');
  if (volume24hQuote < 0n || positionLiquidity < 0n || activePoolLiquidity < 0n)
    throw new RangeError('inputs must be non-negative');
  const n = args.compoundingsPerYear ?? 365;
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError('compoundingsPerYear must be a positive integer');

  const denominator = args.activeLiquidityIncludesPosition
    ? activePoolLiquidity
    : activePoolLiquidity + positionLiquidity;
  if (args.activeLiquidityIncludesPosition && positionLiquidity > activePoolLiquidity)
    throw new RangeError(
      'position liquidity exceeds the pool liquidity that supposedly contains it',
    );
  const shareWad = denominator === 0n ? 0n : mulDiv(positionLiquidity, WAD, denominator, 'floor');

  const poolFeesPerDay = mulDiv(volume24hQuote, BigInt(feePpm), PPM, 'floor');
  const afterShare = mulDiv(poolFeesPerDay, shareWad, WAD, 'floor');
  const feesPerDayQuote = mulDiv(afterShare, BigInt(args.timeInRangeBps), BPS, 'floor');

  const aprWad = mulDiv(feesPerDayQuote * 365n, WAD, capitalQuote, 'floor');
  const perPeriod = aprWad / BigInt(n);
  const apyWad = powWad(WAD + perPeriod, n) - WAD;

  return {
    basis: 'estimated',
    feesPerDayQuote,
    capitalQuote,
    aprWad,
    apyWad,
    assumptions: [
      'Pool-wide 24h volume repeats every day for the whole year',
      'All volume trades against the liquidity active at the current price',
      'Active pool liquidity and the position share stay as observed',
      `Position is in range ${args.timeInRangeBps / 100}% of the time (assumed, not measured)`,
      `Year = 365 days; APY compounds ${n}x per year assuming fees are reinvested at the same rate`,
      'Fees rounded down at each step (conservative)',
    ],
  };
}

export interface RealizedFeeYield {
  readonly basis: 'realized';
  readonly feesCollectedQuote: bigint;
  readonly avgCapitalQuote: bigint;
  readonly elapsedSeconds: bigint;
  /** fees / avgCapital over the observed period, WAD, rounded down. This is the observed return. */
  readonly periodReturnWad: bigint;
  /** periodReturn scaled linearly to 365 days. Arithmetic on the observation, not a prediction. */
  readonly annualizedAprWad: bigint;
}

/** Observed fee yield from fees that were actually earned. `avgCapitalQuote` should be time-weighted by the caller. */
export function realizedFeeYield(args: {
  feesCollectedQuote: bigint;
  avgCapitalQuote: bigint;
  elapsedSeconds: bigint;
}): RealizedFeeYield {
  const { feesCollectedQuote, avgCapitalQuote, elapsedSeconds } = args;
  if (feesCollectedQuote < 0n) throw new RangeError('fees must be non-negative');
  if (avgCapitalQuote <= 0n) throw new RangeError('average capital must be positive');
  if (elapsedSeconds <= 0n) throw new RangeError('elapsed time must be positive');
  return {
    basis: 'realized',
    feesCollectedQuote,
    avgCapitalQuote,
    elapsedSeconds,
    periodReturnWad: mulDiv(feesCollectedQuote, WAD, avgCapitalQuote, 'floor'),
    annualizedAprWad: mulDiv(
      feesCollectedQuote * SECONDS_PER_YEAR,
      WAD,
      avgCapitalQuote * elapsedSeconds,
      'floor',
    ),
  };
}

export interface NetYieldInput {
  readonly avgCapitalQuote: bigint;
  readonly elapsedSeconds: bigint;
  /** Cash events that happened. */
  readonly realized: {
    readonly feesCollectedQuote: bigint;
    readonly gasPaidQuote: bigint;
    readonly swapCostsPaidQuote: bigint;
  };
  /** Mark-to-market at an observed price. `impermanentLossQuote` is <= 0. */
  readonly marked: {
    readonly uncollectedFeesQuote: bigint;
    readonly impermanentLossQuote: bigint;
  };
  /** Optional forward-looking block. Kept entirely separate in the output. */
  readonly estimated?: {
    readonly horizonSeconds: bigint;
    readonly projectedFeesQuote: bigint;
    readonly projectedGasQuote: bigint;
    readonly projectedSwapCostQuote: bigint;
    readonly assumptions: readonly string[];
  };
}

export interface NetYield {
  readonly realized: {
    readonly basis: 'realized';
    /** fees collected - gas - swap costs */
    readonly netQuote: bigint;
    readonly annualizedAprWad: bigint;
  };
  readonly marked: {
    readonly basis: 'marked';
    /** realized net + uncollected fees + IL. The honest "profit versus just holding" to date. */
    readonly netVsHodlQuote: bigint;
    readonly annualizedAprWad: bigint;
    /** True when fees (collected + uncollected) exceed the impermanent loss. */
    readonly feesCoverIl: boolean;
  };
  readonly estimated: null | {
    readonly basis: 'estimated';
    readonly netQuote: bigint;
    /** Return over the horizon (not annualized unless the horizon is a year), WAD. */
    readonly horizonReturnWad: bigint;
    readonly annualizedAprWad: bigint;
    readonly assumptions: readonly string[];
  };
}

const annualize = (amount: bigint, capital: bigint, seconds: bigint): bigint =>
  divRound(amount * SECONDS_PER_YEAR * WAD, capital * seconds, 'floor');

/**
 * Net yield with realized, marked and estimated figures reported side by side and never merged.
 * Costs are subtracted from realized income; impermanent loss only enters the marked view.
 */
export function netYield(input: NetYieldInput): NetYield {
  const { avgCapitalQuote, elapsedSeconds, realized, marked } = input;
  if (avgCapitalQuote <= 0n) throw new RangeError('average capital must be positive');
  if (elapsedSeconds <= 0n) throw new RangeError('elapsed time must be positive');
  for (const [name, v] of Object.entries({
    ...realized,
    uncollectedFeesQuote: marked.uncollectedFeesQuote,
  })) {
    if (v < 0n) throw new RangeError(`${name} must be non-negative`);
  }
  if (marked.impermanentLossQuote > 0n)
    throw new RangeError('impermanentLossQuote must be <= 0 (it is a loss or zero)');

  const realizedNet =
    realized.feesCollectedQuote - realized.gasPaidQuote - realized.swapCostsPaidQuote;
  const markedNet = realizedNet + marked.uncollectedFeesQuote + marked.impermanentLossQuote;
  const totalFees = realized.feesCollectedQuote + marked.uncollectedFeesQuote;

  let estimated: NetYield['estimated'] = null;
  if (input.estimated) {
    const e = input.estimated;
    if (e.horizonSeconds <= 0n) throw new RangeError('horizon must be positive');
    if (e.projectedFeesQuote < 0n || e.projectedGasQuote < 0n || e.projectedSwapCostQuote < 0n)
      throw new RangeError('projections must be non-negative');
    const net = e.projectedFeesQuote - e.projectedGasQuote - e.projectedSwapCostQuote;
    estimated = {
      basis: 'estimated',
      netQuote: net,
      horizonReturnWad: divRound(net * WAD, avgCapitalQuote, 'floor'),
      annualizedAprWad: annualize(net, avgCapitalQuote, e.horizonSeconds),
      assumptions: e.assumptions,
    };
  }

  return {
    realized: {
      basis: 'realized',
      netQuote: realizedNet,
      annualizedAprWad: annualize(realizedNet, avgCapitalQuote, elapsedSeconds),
    },
    marked: {
      basis: 'marked',
      netVsHodlQuote: markedNet,
      annualizedAprWad: annualize(markedNet, avgCapitalQuote, elapsedSeconds),
      feesCoverIl: totalFees >= absBig(marked.impermanentLossQuote),
    },
    estimated,
  };
}

/** Days of estimated fee income needed to pay back `costQuote`. Estimated by nature. null if income is zero. */
export function paybackDays(args: { costQuote: bigint; estimatedFeesPerDayQuote: bigint }): {
  basis: 'estimated';
  days: bigint | null;
} {
  if (args.costQuote < 0n || args.estimatedFeesPerDayQuote < 0n)
    throw new RangeError('inputs must be non-negative');
  if (args.costQuote === 0n) return { basis: 'estimated', days: 0n };
  if (args.estimatedFeesPerDayQuote === 0n) return { basis: 'estimated', days: null };
  return {
    basis: 'estimated',
    days: divRound(args.costQuote, args.estimatedFeesPerDayQuote, 'ceil'),
  };
}
