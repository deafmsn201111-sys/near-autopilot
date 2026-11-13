import { describe, expect, it } from 'vitest';
import {
  healthZone,
  hfAfterRepay,
  repayToReach,
  toRawAmount,
  withdrawableToKeep,
  type LoanModel,
} from '../src/loan-math';

// The demo wallet: 53.87 USDC collateral, 37.87 USDC borrowed, volatility ratio 0.95, $1 per token.
const demo: LoanModel = {
  collateralAdjUsd: 53.87 * 0.95,
  debtAdjUsd: 37.87 / 0.95,
  vr: 0.95,
  usdPerToken: 1,
};
const directHf = (collateral: number, debt: number) => (collateral * 0.95) / (debt / 0.95);

describe('loan math (Burrow health factor)', () => {
  it('repaying from collateral lowers both sides by the same tokens', () => {
    expect(hfAfterRepay(demo, 10, 'collateral')).toBeCloseTo(directHf(43.87, 27.87), 9);
  });

  it('repaying from the wallet lowers only the debt', () => {
    expect(hfAfterRepay(demo, 10, 'wallet')).toBeCloseTo(directHf(53.87, 27.87), 9);
  });

  it('repaying the whole debt leaves no health factor (nothing to liquidate)', () => {
    expect(hfAfterRepay(demo, 37.87, 'collateral')).toBeNull();
  });

  it('sizes the repayment from collateral that restores the target exactly', () => {
    const x = repayToReach(demo, 1.6, 'collateral');
    expect(x).toBeCloseTo(17.1676, 3);
    expect(directHf(53.87 - x, 37.87 - x)).toBeCloseTo(1.6, 9);
  });

  it('sizes the repayment from the wallet that restores the target exactly', () => {
    const x = repayToReach(demo, 1.6, 'wallet');
    expect(directHf(53.87, 37.87 - x)).toBeCloseTo(1.6, 9);
  });

  it('needs no repayment when the target is already met', () => {
    expect(repayToReach(demo, 1.2, 'collateral')).toBe(0);
  });

  it('withdraws only what keeps the health factor at the target, everything when there is no debt', () => {
    const after = { ...demo, debtAdjUsd: 20 / 0.95 };
    const x = withdrawableToKeep(after, 1.6);
    expect(directHf(53.87 - x, 20)).toBeCloseTo(1.6, 9);
    expect(withdrawableToKeep(demo, 1.6)).toBe(0);
    expect(withdrawableToKeep({ ...demo, debtAdjUsd: 0 }, 1.6)).toBe(Infinity);
  });

  it('colours a health factor by the same zones as the loan-safety chip', () => {
    expect(healthZone(1.05)).toBe('high');
    expect(healthZone(1.28)).toBe('medium');
    expect(healthZone(1.6)).toBe('low');
    expect(healthZone(null)).toBe('low');
  });

  it('turns a typed decimal amount into exact base units', () => {
    expect(toRawAmount('17.30', 6)).toBe(17_300_000n);
    expect(toRawAmount('0.1', 24)).toBe(100_000_000_000_000_000_000_000n);
    expect(toRawAmount('1.2345678', 6)).toBe(1_234_567n);
    expect(toRawAmount('abc', 6)).toBeNull();
    expect(toRawAmount('', 6)).toBeNull();
  });
});
