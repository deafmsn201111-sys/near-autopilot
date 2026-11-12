import { describe, expect, it } from 'vitest';
import { accountPortfolio, portfolioMetrics } from '../src/analytics/account-view';

const leg = (
  token: string,
  symbol: string,
  protocol: string,
  usd: number,
  kind: 'asset' | 'debt' = 'asset',
) => ({
  token,
  symbol,
  protocol,
  usd,
  kind,
});

describe('portfolioMetrics', () => {
  it('aggregates by token and by protocol, and reports single-asset concentration', () => {
    const m = portfolioMetrics([
      leg('wrap.near', 'wNEAR', 'Wallet', 600),
      leg('wrap.near', 'wNEAR', 'Rhea DCL', 300), // same token, different venue
      leg('usdt.tether-token.near', 'USDt', 'Burrow', 100),
      leg('usdt.tether-token.near', 'USDt', 'Burrow', 400, 'debt'), // debt: excluded from assets
    ]);
    expect(m.totalAssetsUsd).toBe(1000);
    expect(m.totalDebtUsd).toBe(400);
    expect(m.netUsd).toBe(600);
    // by token: wNEAR 900 (90%), USDt 100 (10%)
    expect(m.byToken.map((t) => [t.symbol, t.usd, t.pct])).toEqual([
      ['wNEAR', 900, 90],
      ['USDt', 100, 10],
    ]);
    // by protocol: Wallet 600, Rhea DCL 300, Burrow 100
    expect(m.byProtocol.map((p) => [p.protocol, p.usd])).toEqual([
      ['Wallet', 600],
      ['Rhea DCL', 300],
      ['Burrow', 100],
    ]);
    expect(m.concentration).toEqual({ token: 'wrap.near', symbol: 'wNEAR', pct: 90 });
  });

  it('is empty-safe', () => {
    const m = portfolioMetrics([]);
    expect(m.totalAssetsUsd).toBe(0);
    expect(m.concentration).toBeNull();
    expect(m.byToken).toEqual([]);
  });
});

describe('accountPortfolio', () => {
  const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const p = accountPortfolio({
    holdings: [
      { where: 'wallet', token: USDC, symbol: 'USDC', amount: 40, usd: 40 },
      { where: 'wallet', token: 'near', symbol: 'NEAR', amount: 2, usd: 6 },
      { where: 'wallet', token: 'meta-pool.near', symbol: 'stNEAR', amount: 1, usd: 4 },
      { where: 'deposited', token: USDC, symbol: 'USDC', amount: 10, usd: 10 },
      { where: 'collateral', token: 'wrap.near', symbol: 'wNEAR', amount: 10, usd: 30 },
      { where: 'borrowed', token: USDC, symbol: 'USDC', amount: 20, usd: 20 },
      { where: 'wallet', token: 'unpriced.near', symbol: 'X', amount: 5, usd: null },
    ],
    staking: [{ token: 'meta-pool.near', symbol: 'stNEAR', usd: 4 }],
    v1Positions: [{ tokens: [USDC, 'wrap.near'], symbols: ['USDC', 'wNEAR'], usdPerToken: [8, 8] }],
    dclPositions: [
      { tokenX: USDC, tokenY: 'wrap.near', symbolX: 'USDC', symbolY: 'wNEAR', usdX: 2, usdY: null },
    ],
  });

  it('counts wallet, Burrow and LP once each, and a wallet-held staking token once', () => {
    expect(p.totals).toEqual({ assetsUsd: 108, debtUsd: 20, netWorthUsd: 88, idleUsd: 50 });
    expect(p.metrics.totalAssetsUsd).toBe(p.totals.assetsUsd);
    expect(p.metrics.byToken.find((t) => t.symbol === 'stNEAR')?.usd).toBe(4);
  });

  it('the concentration % is the top token share of the same total', () => {
    expect(p.metrics.concentration).toEqual({ token: USDC, symbol: 'USDC', pct: (60 / 108) * 100 });
    expect(p.metrics.byToken[0]?.pct).toBe(p.metrics.concentration?.pct);
  });

  it('counts a staking token the wallet list does not hold', () => {
    const q = accountPortfolio({
      holdings: [],
      staking: [{ token: 'linear-protocol.near', symbol: 'LiNEAR', usd: 5 }],
      v1Positions: [],
      dclPositions: [],
    });
    expect(q.totals.assetsUsd).toBe(5);
  });
});
