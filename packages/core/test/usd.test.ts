import { describe, expect, it } from 'vitest';
import { decimalToScaled, formatMicroUsd, hasAtMostDecimals, usdToMicro } from '../src';

describe('exact decimal conversion', () => {
  it('converts config decimals without float multiplication', () => {
    expect(usdToMicro(100)).toBe(100_000_000n);
    expect(usdToMicro(0.1)).toBe(100_000n);
    expect(usdToMicro(1234.567891)).toBe(1_234_567_891n);
    expect(decimalToScaled(1.3, 4)).toBe(13_000n);
    expect(decimalToScaled(1.0001, 4)).toBe(10_001n);
    expect(decimalToScaled(-2.5, 2)).toBe(-250n);
  });

  it('refuses values it would have to round', () => {
    expect(hasAtMostDecimals(0.1234567, 6)).toBe(false);
    expect(hasAtMostDecimals(1e-7, 6)).toBe(false);
    expect(hasAtMostDecimals(1e21, 6)).toBe(false);
    expect(hasAtMostDecimals(Number.NaN, 6)).toBe(false);
    expect(() => usdToMicro(0.1234567)).toThrow(RangeError);
    expect(() => usdToMicro(-1)).toThrow(RangeError);
    expect(() => decimalToScaled(1.00005, 4)).toThrow(RangeError);
  });

  it('formats micro-USD exactly', () => {
    expect(formatMicroUsd(1_234_500_000n)).toBe('1234.50');
    expect(formatMicroUsd(-1n)).toBe('-0.000001');
  });
});
