import { describe, expect, it } from 'vitest';
import { shareOf, withdrawSources } from '../lib/withdraw';

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

const USDC = { assetId: 'nep141:usdc.near', symbol: 'USDC', decimals: 6 };
const WNEAR = { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 };

describe('withdrawSources', () => {
  it('offers held tokens only, with their balance', () => {
    expect(withdrawSources([USDC, WNEAR], [{ token: 'usdc.near', amount: 3 }])).toEqual([
      { ...USDC, balance: 3 },
    ]);
  });

  it('joins native NEAR to wNEAR as NEAR, keeping 1 NEAR for fees', () => {
    const balances = [
      { token: 'near', amount: 5.3 },
      { token: 'wrap.near', amount: 0.1 },
    ];
    expect(withdrawSources([WNEAR], balances)).toEqual([
      { ...WNEAR, symbol: 'NEAR', balance: 4.4 },
    ]);
  });

  it('does not offer NEAR when only the fee reserve is held', () => {
    expect(withdrawSources([WNEAR], [{ token: 'near', amount: 0.9 }])).toEqual([]);
  });
});
