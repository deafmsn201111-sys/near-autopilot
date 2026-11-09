import { describe, expect, it } from 'vitest';
import { resolveBalancedLpAmounts, resolveIntentAmount, toRawUnits } from '../src/wallet/amounts';

describe('toRawUnits', () => {
  it('scales by decimals and floors (never rounds up)', () => {
    expect(toRawUnits(1, 24)).toBe(10n ** 24n);
    expect(toRawUnits(1.5, 6)).toBe(1_500_000n);
    expect(toRawUnits(0.000001, 6)).toBe(1n);
    expect(toRawUnits(1.9999999, 6)).toBe(1_999_999n); // floored, not 2_000_000
    expect(toRawUnits(0, 24)).toBe(0n);
  });
  it('rejects bad input', () => {
    expect(() => toRawUnits(-1, 6)).toThrow();
    expect(() => toRawUnits(1, -1)).toThrow();
  });
});

describe('resolveIntentAmount', () => {
  it('sizes a USD intent at the token price, in raw units', () => {
    // $1188 of NEAR at $4.50 = 264 NEAR
    const r = resolveIntentAmount(1188, 4.5, 24);
    expect(r.humanAmount).toBeCloseTo(264, 6);
    expect(r.rawAmount).toBe(264n * 10n ** 24n);
  });
  it('is capped at the wallet balance so it never exceeds what the user holds', () => {
    const r = resolveIntentAmount(1000, 1, 6, 400); // wants 1000 USDt but only 400 held
    expect(r.humanAmount).toBe(400);
    expect(r.rawAmount).toBe(400_000_000n);
  });
  it('requires a positive price', () => {
    expect(() => resolveIntentAmount(100, 0, 24)).toThrow();
  });
});

describe('resolveBalancedLpAmounts', () => {
  // Pool 3879-like: ~530.68 wNEAR + 1876.60 USDt; NEAR ~$3.54, USDt $1.
  const base = {
    reserve0Human: 530.676619,
    reserve1Human: 1876.60321,
    price0Usd: 3.54,
    price1Usd: 1,
    decimals0: 24,
    decimals1: 6,
    wallet0Human: 1e9,
    wallet1Human: 1e9,
  };

  it('splits the budget in the pool reserve ratio and sums to ~budget', () => {
    const { side0, side1 } = resolveBalancedLpAmounts({ ...base, budgetUsd: 100 });
    const ratio = side0.humanAmount / side1.humanAmount;
    expect(ratio).toBeCloseTo(base.reserve0Human / base.reserve1Human, 6);
    const totalUsd = side0.humanAmount * base.price0Usd + side1.humanAmount * base.price1Usd;
    expect(totalUsd).toBeCloseTo(100, 6);
  });

  it('floors to raw units (never rounds up)', () => {
    const { side0, side1 } = resolveBalancedLpAmounts({ ...base, budgetUsd: 100 });
    expect(side0.rawAmount).toBe(toRawUnits(side0.humanAmount, 24));
    expect(side1.rawAmount).toBe(toRawUnits(side1.humanAmount, 6));
  });

  it('caps both sides by the tighter wallet balance, preserving the ratio', () => {
    const { side0, side1 } = resolveBalancedLpAmounts({
      ...base,
      budgetUsd: 1_000_000,
      wallet0Human: 1,
      wallet1Human: 1e9,
    });
    expect(side0.humanAmount).toBeLessThanOrEqual(1 + 1e-9);
    const ratio = side0.humanAmount / side1.humanAmount;
    expect(ratio).toBeCloseTo(base.reserve0Human / base.reserve1Human, 6);
  });

  it('rejects non-positive budget, reserves or prices', () => {
    expect(() => resolveBalancedLpAmounts({ ...base, budgetUsd: 0 })).toThrow(RangeError);
    expect(() => resolveBalancedLpAmounts({ ...base, budgetUsd: 100, reserve0Human: 0 })).toThrow(
      RangeError,
    );
    expect(() => resolveBalancedLpAmounts({ ...base, budgetUsd: 100, price1Usd: 0 })).toThrow(
      RangeError,
    );
  });
});
