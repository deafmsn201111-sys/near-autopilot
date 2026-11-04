import { describe, expect, it } from 'vitest';
import { innerToRaw, pow10, rawToInner } from '../src';

describe('Burrow inner units', () => {
  it('rawToInner multiplies by 10^extra_decimals', () => {
    expect(rawToInner(42n, 0)).toBe(42n);
    expect(rawToInner(42n, 18)).toBe(42n * 10n ** 18n);
  });

  it('innerToRaw is exact when divisible', () => {
    expect(innerToRaw(42n * 10n ** 18n, 18, 'floor')).toBe(42n);
    expect(innerToRaw(42n * 10n ** 18n, 18, 'ceil')).toBe(42n);
  });

  it('rounds holdings down and debt up when not divisible', () => {
    const inner = 42n * 10n ** 18n + 1n;
    expect(innerToRaw(inner, 18, 'floor')).toBe(42n);
    expect(innerToRaw(inner, 18, 'ceil')).toBe(43n);
    expect(innerToRaw(1n, 18, 'floor')).toBe(0n);
    expect(innerToRaw(1n, 18, 'ceil')).toBe(1n);
  });

  it('rejects negative amounts and absurd exponents', () => {
    expect(() => rawToInner(-1n, 0)).toThrow(RangeError);
    expect(() => innerToRaw(-1n, 0, 'floor')).toThrow(RangeError);
    expect(() => pow10(-1)).toThrow(RangeError);
    expect(() => pow10(78)).toThrow(RangeError);
  });
});
