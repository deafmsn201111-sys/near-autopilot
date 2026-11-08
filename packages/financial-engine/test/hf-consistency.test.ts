import { describe, expect, it } from 'vitest';
import type { UnitPrice } from '@near-autopilot/core';
import { assessLendingPosition, BPS, healthFactorBps, WAD, type LendingModel } from '../src';

/**
 * T2.1 — the two in-tree health-factor computations must not diverge.
 *
 * The orchestrator decides on `assessLendingPosition().healthFactorWad` (WAD, the authoritative one). The legacy
 * engine uses `healthFactorBps` (basis points). In the production orchestrator path they are fed the SAME risk
 * parameter (orchestrator/risk-state.ts sets liquidationThresholdBps = collateralFactorBps), so they are the same
 * quantity at two scales. This pins that: for the same position, the bps value equals the WAD value truncated to
 * bps — never diverging, and the WAD value is never the more optimistic of the two.
 */

const price = (multiplier: bigint, decimals: number): UnitPrice => ({ multiplier, decimals });

// A few positions across the HF range (healthy, near the line, deep).
const models: LendingModel[] = [
  {
    collateral: [
      {
        id: 'near',
        amount: 100n * 10n ** 24n,
        price: price(50_000n, 28),
        liquidationThresholdBps: 7000,
      },
    ],
    debt: [
      { id: 'usdt', amount: 200n * 10n ** 6n, price: price(10_000n, 10), borrowFactorBps: 9000 },
    ],
  },
  {
    collateral: [
      {
        id: 'near',
        amount: 1234n * 10n ** 23n,
        price: price(37_123n, 28),
        liquidationThresholdBps: 6000,
      },
    ],
    debt: [
      { id: 'usdt', amount: 999n * 10n ** 6n, price: price(10_001n, 10), borrowFactorBps: 9500 },
    ],
  },
  {
    collateral: [
      {
        id: 'near',
        amount: 50n * 10n ** 24n,
        price: price(50_000n, 28),
        liquidationThresholdBps: 7000,
      },
      {
        id: 'usdt',
        amount: 500n * 10n ** 6n,
        price: price(10_000n, 10),
        liquidationThresholdBps: 9500,
      },
    ],
    debt: [
      { id: 'usdt', amount: 400n * 10n ** 6n, price: price(10_000n, 10), borrowFactorBps: 9000 },
    ],
  },
];

describe('health-factor consistency (WAD vs bps)', () => {
  it('healthFactorBps equals healthFactorWad truncated to bps, for every position', () => {
    for (const model of models) {
      const a = assessLendingPosition(model);
      const bps = healthFactorBps({
        adjustedCollateralUsd: a.adjustedCollateralUsd,
        adjustedBorrowedUsd: a.adjustedDebtUsd,
      });
      expect(a.healthFactorWad).not.toBeNull();
      expect(bps).not.toBeNull();
      const wad = a.healthFactorWad as bigint;
      // The WAD value, truncated to bps precision, must equal the bps value exactly.
      expect((wad * BPS) / WAD).toBe(bps);
      // And the WAD value is never below its bps truncation (same conservative rounding direction).
      expect(wad).toBeGreaterThanOrEqual(((bps as bigint) * WAD) / BPS);
      // The residual lost to bps truncation is sub-bps.
      expect(wad - ((bps as bigint) * WAD) / BPS).toBeLessThan(WAD / BPS);
    }
  });

  it('both report "no debt" (null) together', () => {
    const noDebt: LendingModel = {
      collateral: [
        {
          id: 'near',
          amount: 10n * 10n ** 24n,
          price: price(50_000n, 28),
          liquidationThresholdBps: 7000,
        },
      ],
      debt: [],
    };
    const a = assessLendingPosition(noDebt);
    expect(a.healthFactorWad).toBeNull();
    expect(
      healthFactorBps({
        adjustedCollateralUsd: a.adjustedCollateralUsd,
        adjustedBorrowedUsd: a.adjustedDebtUsd,
      }),
    ).toBeNull();
  });
});
