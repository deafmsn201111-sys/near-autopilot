import { describe, expect, it } from 'vitest';
import type { LendingPosition } from '@near-autopilot/core';
import { accountId } from '@near-autopilot/core';
import {
  collateralValueForTargetHealthFactor,
  healthFactor,
  lendingTotals,
  repayAmountForTargetHealthFactor,
} from '../src';
import { USDT, WNEAR, near, prices, risk, usdt } from './fixtures';

const position = (borrowedUsdt: bigint): LendingPosition => ({
  protocol: 'burrow',
  accountId: accountId('alice.near'),
  supplied: [],
  collateral: [{ token: WNEAR, raw: near(100) }], // $500 * 0.70 = $350 adjusted
  borrowed: [{ token: USDT, raw: borrowedUsdt }], // $200 / 0.90 = $222.22 adjusted
});

describe('lending maths', () => {
  it('computes totals and health factor', () => {
    const totals = lendingTotals(position(usdt(200)), prices, risk);
    expect(totals.collateralUsd).toBe(500_000_000n);
    expect(totals.borrowedUsd).toBe(200_000_000n);
    expect(totals.adjustedCollateralUsd).toBe(350_000_000n);
    expect(healthFactor(totals)).toBeCloseTo(1.575, 2);
  });

  it('returns null health factor when there is no debt', () => {
    const totals = lendingTotals(position(0n), prices, risk);
    expect(healthFactor(totals)).toBeNull();
  });

  it('repay amount reaches the target health factor', () => {
    const before = lendingTotals(position(usdt(200)), prices, risk);
    const amount = repayAmountForTargetHealthFactor({
      totals: before,
      prices,
      risk,
      debtToken: USDT,
      targetBps: 20_000,
    });
    expect(amount).toBeGreaterThan(0n);
    const after = lendingTotals(position(usdt(200) - amount), prices, risk);
    expect(healthFactor(after) ?? 0).toBeGreaterThanOrEqual(1.99);
  });

  it('repay amount is zero when already above target', () => {
    const totals = lendingTotals(position(usdt(10)), prices, risk);
    expect(
      repayAmountForTargetHealthFactor({
        totals,
        prices,
        risk,
        debtToken: USDT,
        targetBps: 15_000,
      }),
    ).toBe(0n);
  });

  it('collateral needed reaches the target health factor', () => {
    const totals = lendingTotals(position(usdt(200)), prices, risk);
    const value = collateralValueForTargetHealthFactor(totals, 20_000, 7000);
    // adjusted collateral must reach 2 * 222.22 = 444.44 => add (444.44 - 350) / 0.7 = 134.9
    expect(Number(value) / 1e6).toBeCloseTo(134.92, 1);
  });

  it('rejects nonsensical targets', () => {
    const totals = lendingTotals(position(usdt(200)), prices, risk);
    expect(() => collateralValueForTargetHealthFactor(totals, 9_000, 7000)).toThrow(RangeError);
  });
});
