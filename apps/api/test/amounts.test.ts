import { describe, expect, it } from 'vitest';
import {
  exactAmount,
  resolveBalancedLpAmounts,
  resolveIntentAmount,
  lpMinAmounts,
  toRawUnits,
} from '../src/wallet/amounts';

const WALLET_24 = 1_234_567_890_123_456_789_012_345n;

describe('toRawUnits', () => {
  it('scales by decimals and floors (never rounds up)', () => {
    expect(toRawUnits(1, 24)).toBe(10n ** 24n);
    expect(toRawUnits(1.5, 6)).toBe(1_500_000n);
    expect(toRawUnits(0.000001, 6)).toBe(1n);
    expect(toRawUnits(1.9999999, 6)).toBe(1_999_999n); // floored, not 2_000_000
    expect(toRawUnits(0, 24)).toBe(0n);
  });
  it('handles amounts of 1e21 and above, where toFixed switches to exponent notation', () => {
    expect(toRawUnits(1e21, 0)).toBe(10n ** 21n);
    expect(toRawUnits(2 ** 80, 6)).toBe(2n ** 80n * 10n ** 6n);
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
    const r = resolveIntentAmount(1000, 1, 6, 400_000_000n); // wants 1000 USDt but only 400 held
    expect(r.humanAmount).toBe(400);
    expect(r.rawAmount).toBe(400_000_000n);
  });
  it('caps "max" at the exact raw balance even when the float rounds a 24-decimal balance up', () => {
    const r = resolveIntentAmount(1e12, 1, 24, WALLET_24);
    expect(r.rawAmount).toBe(WALLET_24);
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
    wallet0Raw: 10n ** 33n,
    wallet1Raw: 10n ** 15n,
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
      wallet0Raw: 10n ** 24n,
    });
    expect(side0.humanAmount).toBeLessThanOrEqual(1 + 1e-9);
    const ratio = side0.humanAmount / side1.humanAmount;
    expect(ratio).toBeCloseTo(base.reserve0Human / base.reserve1Human, 6);
  });

  it('never exceeds the exact raw wallet balance on either side', () => {
    const { side0, side1 } = resolveBalancedLpAmounts({
      ...base,
      budgetUsd: 1e15,
      wallet0Raw: WALLET_24,
      wallet1Raw: 10n ** 15n,
    });
    expect(side0.rawAmount).toBeLessThanOrEqual(WALLET_24);
    expect(side1.rawAmount).toBeLessThanOrEqual(10n ** 15n);
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

describe('exactAmount', () => {
  it('uses the agent-sized amount as is when the wallet holds it', () => {
    expect(exactAmount(1_500_000n, 2_000_000n, 6)).toEqual({
      rawAmount: 1_500_000n,
      humanAmount: 1.5,
    });
  });

  it('never spends more than the wallet holds', () => {
    expect(exactAmount(5_000_000n, 2_000_000n, 6)).toEqual({
      rawAmount: 2_000_000n,
      humanAmount: 2,
    });
  });
});

describe('lpMinAmounts', () => {
  it('requires the pool to consume at least 99.5% of each side, floored', () => {
    expect(lpMinAmounts([1_000_000n, 2_000_001n])).toEqual([995_000n, 1_990_000n]);
  });
});
