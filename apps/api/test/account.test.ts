import { describe, expect, it } from 'vitest';
import { accountId, type TokenId } from '@near-autopilot/core';
import { valueAccount, type TokenFacts } from '../src/analytics/account';

const USDC = 'usdc.near' as TokenId;
const WNEAR = 'wrap.near' as TokenId;
const facts = new Map<string, TokenFacts>([
  [WNEAR, { decimals: 24, symbol: 'wNEAR', usd: 3, extraDecimals: 0, vr: 0.6 }],
  [USDC, { decimals: 6, symbol: 'USDC', usd: 1, extraDecimals: 12, vr: 0.95 }],
]);

describe('a real account, valued read-only', () => {
  it("values wallet, deposits, collateral and debt, and computes Burrow's health factor", () => {
    const v = valueAccount(
      {
        accountId: accountId('alice.near'),
        nativeYocto: 10n * 10n ** 24n, // 10 NEAR
        wallet: new Map([[USDC, 250n * 10n ** 6n]]),
        burrow: {
          supplied: [],
          collateral: [{ token: WNEAR, inner: 1000n * 10n ** 24n }], // 1000 wNEAR = $3,000
          borrowed: [{ token: USDC, inner: 900n * 10n ** 6n * 10n ** 12n }], // 900 USDC (inner has 12 extra decimals)
        },
      },
      facts,
    );
    expect(v.totals).toMatchObject({ assetsUsd: 30 + 250 + 3000, debtUsd: 900, idleUsd: 280 });
    // HF = (3000 x 0.6) / (900 / 0.95)
    expect(v.loan.healthFactor).toBeCloseTo((3000 * 0.6) / (900 / 0.95), 9);
    expect(v.loan.collateralDropToLiquidation).toBeCloseTo(
      1 - 1 / ((3000 * 0.6) / (900 / 0.95)),
      9,
    );
  });

  it('an account without a loan has no health factor, and a token without a price is reported, never valued at 0', () => {
    const v = valueAccount(
      {
        accountId: accountId('bob.near'),
        nativeYocto: 0n,
        wallet: new Map([['unknown.near' as TokenId, 5n]]),
        burrow: null,
      },
      new Map([...facts, ['unknown.near', { decimals: 0, symbol: 'UNK', usd: null }]]),
    );
    expect(v.loan).toMatchObject({ hasDebt: false, healthFactor: null });
    expect(v.unpriced).toEqual(['UNK']);
    expect(v.holdings[0]).toMatchObject({ symbol: 'UNK', usd: null });
  });
});
