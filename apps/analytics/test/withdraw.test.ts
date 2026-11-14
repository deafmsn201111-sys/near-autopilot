import { describe, expect, it } from 'vitest';
import { shareOf } from '../lib/withdraw';

describe('shareOf', () => {
  it('gives a share of the balance, rounded down', () => {
    expect(shareOf(5.123457, 100, 6)).toBe('5.123457');
    expect(shareOf(5.123457, 50, 6)).toBe('2.561728');
    expect(shareOf(10, 25, 6)).toBe('2.5');
    expect(shareOf(0.000003, 25, 6)).toBe('0');
  });

  it('never asks more than a float balance holds, and keeps the token decimals', () => {
    expect(shareOf(0.3, 100, 24)).toBe('0.3');
    expect(shareOf(1.000001, 100, 2)).toBe('1');
    expect(shareOf(7, 50, 0)).toBe('3');
  });
});
