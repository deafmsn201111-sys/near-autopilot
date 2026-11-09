import { describe, expect, it } from 'vitest';
import { resolveIntentAmount, toRawUnits } from '../src/wallet/amounts';

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
