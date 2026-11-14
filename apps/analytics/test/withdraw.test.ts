import { describe, expect, it } from 'vitest';
import { withdrawSources } from '../lib/withdraw';

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
