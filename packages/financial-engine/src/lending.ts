import {
  type AssetBalance,
  type AssetRisk,
  type LendingPosition,
  type PriceMap,
  type TokenId,
  MissingPriceError,
} from '@near-autopilot/core';
import { priceOf, rawForValueUsd, sumValueUsd, tokenValueUsd } from './valuation';

const BPS = 10_000n;

export interface LendingTotals {
  readonly suppliedUsd: bigint;
  readonly collateralUsd: bigint;
  readonly borrowedUsd: bigint;
  /** Σ collateral value × collateralFactor. */
  readonly adjustedCollateralUsd: bigint;
  /** Σ borrowed value ÷ borrowFactor. */
  readonly adjustedBorrowedUsd: bigint;
}

function riskOf(risk: ReadonlyMap<TokenId, AssetRisk>, token: TokenId): AssetRisk {
  const found = risk.get(token);
  if (!found) throw new MissingPriceError(`${token} (risk parameters)`);
  return found;
}

export function lendingTotals(
  position: LendingPosition,
  prices: PriceMap,
  risk: ReadonlyMap<TokenId, AssetRisk>,
): LendingTotals {
  let adjustedCollateralUsd = 0n;
  for (const c of position.collateral) {
    const r = riskOf(risk, c.token);
    const value = tokenValueUsd(prices, c.token, c.raw);
    adjustedCollateralUsd += (value * BigInt(r.collateralFactorBps)) / BPS;
  }
  let adjustedBorrowedUsd = 0n;
  for (const b of position.borrowed) {
    const r = riskOf(risk, b.token);
    if (r.borrowFactorBps <= 0) throw new RangeError(`Borrow factor for ${b.token} must be > 0`);
    const value = tokenValueUsd(prices, b.token, b.raw);
    // Round debt UP (as Burrow does): flooring would overstate the health factor near the threshold.
    const factor = BigInt(r.borrowFactorBps);
    adjustedBorrowedUsd += (value * BPS + factor - 1n) / factor;
  }
  return {
    suppliedUsd: sumValueUsd(position.supplied, prices),
    collateralUsd: sumValueUsd(position.collateral, prices),
    borrowedUsd: sumValueUsd(position.borrowed, prices),
    adjustedCollateralUsd,
    adjustedBorrowedUsd,
  };
}

/**
 * Exact health factor in basis points (10_000 = 1.0), rounded DOWN; null when there is no debt. Use this for
 * decisions: it never reports a position healthier than it is.
 */
export function healthFactorBps(
  totals: Pick<LendingTotals, 'adjustedCollateralUsd' | 'adjustedBorrowedUsd'>,
): bigint | null {
  if (totals.adjustedBorrowedUsd === 0n) return null;
  return (totals.adjustedCollateralUsd * BPS) / totals.adjustedBorrowedUsd;
}

/**
 * adjusted collateral ÷ adjusted debt as a number, for DISPLAY only (6 decimals, truncated); null when there is no
 * debt. Liquidation occurs below 1.0. Decisions must use `healthFactorBps`.
 */
export function healthFactor(
  totals: Pick<LendingTotals, 'adjustedCollateralUsd' | 'adjustedBorrowedUsd'>,
): number | null {
  if (totals.adjustedBorrowedUsd === 0n) return null;
  const scaled = (totals.adjustedCollateralUsd * 1_000_000n) / totals.adjustedBorrowedUsd;
  return Number(scaled) / 1_000_000;
}

/**
 * Debt value (micro-USD, in the debt token's own terms) that must be repaid so that
 * HF >= targetBps/10_000. Returns 0n if the position already meets the target.
 *
 *   AC / (AB - r) = target  =>  r = AB - AC / target ;  repaid value v = r × borrowFactor
 */
export function repayValueForTargetHealthFactor(
  totals: Pick<LendingTotals, 'adjustedCollateralUsd' | 'adjustedBorrowedUsd'>,
  targetBps: number,
  borrowFactorBps: number,
): bigint {
  assertTarget(targetBps);
  if (totals.adjustedBorrowedUsd === 0n) return 0n;
  const requiredAdjustedDebt = (totals.adjustedCollateralUsd * BPS) / BigInt(targetBps);
  const adjustedReduction = totals.adjustedBorrowedUsd - requiredAdjustedDebt;
  if (adjustedReduction <= 0n) return 0n;
  // Round up: under-repaying would leave the position below target.
  return (adjustedReduction * BigInt(borrowFactorBps) + BPS - 1n) / BPS;
}

/** Raw amount of `debtToken` to repay to reach the target health factor (0n if already there). */
export function repayAmountForTargetHealthFactor(args: {
  totals: LendingTotals;
  prices: PriceMap;
  risk: ReadonlyMap<TokenId, AssetRisk>;
  debtToken: TokenId;
  targetBps: number;
}): bigint {
  const r = riskOf(args.risk, args.debtToken);
  const value = repayValueForTargetHealthFactor(args.totals, args.targetBps, r.borrowFactorBps);
  if (value === 0n) return 0n;
  return rawForValueUsd(value, priceOf(args.prices, args.debtToken));
}

/**
 * Collateral value (micro-USD) to add so that HF >= targetBps/10_000:
 *   (AC + v × cf) / AB = target  =>  v = (target × AB − AC) / cf
 */
export function collateralValueForTargetHealthFactor(
  totals: Pick<LendingTotals, 'adjustedCollateralUsd' | 'adjustedBorrowedUsd'>,
  targetBps: number,
  collateralFactorBps: number,
): bigint {
  assertTarget(targetBps);
  if (collateralFactorBps <= 0) return 0n;
  if (totals.adjustedBorrowedUsd === 0n) return 0n;
  const requiredAdjustedCollateral = (totals.adjustedBorrowedUsd * BigInt(targetBps)) / BPS;
  const shortfall = requiredAdjustedCollateral - totals.adjustedCollateralUsd;
  if (shortfall <= 0n) return 0n;
  return (shortfall * BPS + BigInt(collateralFactorBps) - 1n) / BigInt(collateralFactorBps);
}

export function largestBalance(
  balances: readonly AssetBalance[],
  prices: PriceMap,
): AssetBalance | undefined {
  let best: AssetBalance | undefined;
  let bestValue = -1n;
  for (const b of balances) {
    if (b.raw === 0n) continue;
    const v = tokenValueUsd(prices, b.token, b.raw);
    if (v > bestValue) {
      best = b;
      bestValue = v;
    }
  }
  return best;
}

function assertTarget(targetBps: number): void {
  if (!Number.isInteger(targetBps) || targetBps <= 10_000) {
    throw new RangeError(`Target health factor must be an integer > 10000 bps, got ${targetBps}`);
  }
}
