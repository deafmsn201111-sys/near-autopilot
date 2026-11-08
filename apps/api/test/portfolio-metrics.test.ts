import { describe, expect, it } from 'vitest';
import { portfolioMetrics } from '../src/analytics/account-view';

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
