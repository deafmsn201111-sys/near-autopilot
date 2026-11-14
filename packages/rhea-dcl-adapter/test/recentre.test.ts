import { describe, expect, it } from 'vitest';
import { POINT_MAX, POINT_MIN, alignRange, recentreSwap } from '../src';

describe('alignRange', () => {
  it('widens the ticks outward to multiples of the point delta', () => {
    expect(alignRange(-605, 595, 40, -5)).toEqual({ leftPoint: -640, rightPoint: 600 });
    expect(alignRange(-605, 595, 1, -5)).toEqual({ leftPoint: -605, rightPoint: 595 });
    expect(alignRange(-400, 400, 200, 0)).toEqual({ leftPoint: -400, rightPoint: 400 });
  });

  it('clamps to the contract bounds', () => {
    expect(alignRange(-900_000, -799_000, 40, -799_500)).toEqual({
      leftPoint: POINT_MIN,
      rightPoint: -799_000,
    });
    expect(alignRange(799_000, 900_000, 40, 799_500)).toEqual({
      leftPoint: 799_000,
      rightPoint: POINT_MAX - 40,
    });
  });

  it('refuses a range that does not hold the current point', () => {
    expect(() => alignRange(0, 400, 40, 400)).toThrow(RangeError);
    expect(() => alignRange(0, 400, 40, -1)).toThrow(RangeError);
    expect(() => alignRange(1.5, 400, 40, 10)).toThrow(RangeError);
  });
});

describe('recentreSwap', () => {
  // At point 0 (price 1) a range symmetric in points holds about equal value of X and Y (the current point counts as
  // Y, a 1/2000 skew at this width).
  const range = { leftPoint: -1000, rightPoint: 1000, currentPoint: 0 };
  const near = (value: bigint, target: bigint) =>
    expect(Math.abs(Number(value - target)) / Number(target)).toBeLessThan(0.005);

  it('sells about half of an all-X position for Y', () => {
    const s = recentreSwap({ ...range, amountX: 1_000_000n, amountY: 0n });
    expect(s?.sell).toBe('x');
    near(s!.amountIn, 500_000n);
  });

  it('sells about half of an all-Y position for X', () => {
    const s = recentreSwap({ ...range, amountX: 0n, amountY: 1_000_000n });
    expect(s?.sell).toBe('y');
    near(s!.amountIn, 500_000n);
  });

  it('skips the swap when the holdings already match the ratio', () => {
    expect(recentreSwap({ ...range, amountX: 500_000n, amountY: 500_000n })).toBeNull();
  });

  it('values X at the current price', () => {
    // Point 6932 is price ~2 Y per X: 1 000 X ~ 2 000 Y, so half the value is ~500 X.
    const s = recentreSwap({
      leftPoint: 5932,
      rightPoint: 7932,
      currentPoint: 6932,
      amountX: 1_000_000n,
      amountY: 0n,
    });
    expect(s?.sell).toBe('x');
    near(s!.amountIn, 500_000n);
  });
});
