import { describe, expect, it } from 'vitest';
import { dclPositionAmounts } from '../src/positions';

const pos = (left: number, right: number, amount: bigint) => ({
  left_point: left,
  right_point: right,
  amount,
});
const L = 1_000_000_000_000_000_000n; // 1e18 liquidity

describe('dclPositionAmounts', () => {
  it('is all token Y when the price is above the range (current >= right)', () => {
    const a = dclPositionAmounts(pos(-2000, -1000, L), 0);
    expect(a.x).toBe(0n);
    expect(a.y).toBeGreaterThan(0n);
  });

  it('is all token X when the price is below the range (current < left)', () => {
    const a = dclPositionAmounts(pos(1000, 2000, L), 0);
    expect(a.y).toBe(0n);
    expect(a.x).toBeGreaterThan(0n);
  });

  it('holds both tokens when the price is inside the range', () => {
    const a = dclPositionAmounts(pos(-1000, 1000, L), 0);
    expect(a.x).toBeGreaterThan(0n);
    expect(a.y).toBeGreaterThan(0n);
  });

  it('scales with liquidity', () => {
    const one = dclPositionAmounts(pos(-1000, 1000, L), 0);
    const ten = dclPositionAmounts(pos(-1000, 1000, 10n * L), 0);
    // ~10x within rounding
    expect(ten.x).toBeGreaterThanOrEqual(one.x * 9n);
    expect(ten.y).toBeGreaterThanOrEqual(one.y * 9n);
  });
});
