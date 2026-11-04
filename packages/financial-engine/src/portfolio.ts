import type { PortfolioSnapshot } from '@near-autopilot/core';
import { healthFactor, lendingTotals } from './lending';
import { sumValueUsd } from './valuation';

export interface PortfolioValuation {
  readonly walletUsd: bigint;
  readonly suppliedUsd: bigint;
  readonly collateralUsd: bigint;
  readonly borrowedUsd: bigint;
  /** wallet + supplied + collateral − borrowed */
  readonly netUsd: bigint;
  readonly healthFactor: number | null;
}

export function valuePortfolio(snapshot: PortfolioSnapshot): PortfolioValuation {
  const walletUsd = sumValueUsd(snapshot.walletBalances, snapshot.prices);
  if (!snapshot.lending) {
    return {
      walletUsd,
      suppliedUsd: 0n,
      collateralUsd: 0n,
      borrowedUsd: 0n,
      netUsd: walletUsd,
      healthFactor: null,
    };
  }
  const totals = lendingTotals(snapshot.lending, snapshot.prices, snapshot.risk);
  return {
    walletUsd,
    suppliedUsd: totals.suppliedUsd,
    collateralUsd: totals.collateralUsd,
    borrowedUsd: totals.borrowedUsd,
    netUsd: walletUsd + totals.suppliedUsd + totals.collateralUsd - totals.borrowedUsd,
    healthFactor: healthFactor(totals),
  };
}
