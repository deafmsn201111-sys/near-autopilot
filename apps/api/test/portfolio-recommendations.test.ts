import { describe, expect, it } from 'vitest';
import { portfolioRecommendations, type PortfolioMetrics } from '../src/analytics/account-view';

const metrics = (over: Partial<PortfolioMetrics>): PortfolioMetrics => ({
  totalAssetsUsd: 1000,
  totalDebtUsd: 0,
  netUsd: 1000,
  byToken: [],
  byProtocol: [],
  concentration: null,
  ...over,
});

describe('portfolioRecommendations', () => {
  it('flags high single-asset concentration with a swap intent to cut it toward half', () => {
    const r = portfolioRecommendations(
      metrics({
        totalAssetsUsd: 1000,
        concentration: { token: 'wrap.near', symbol: 'wNEAR', pct: 90 },
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe('reduce_concentration');
    expect(r[0]?.severity).toBe('warning'); // >= 85%
    expect(r[0]?.intent).toEqual({ action: 'swap', fromToken: 'wrap.near', approxUsd: 400 }); // (90-50)% of 1000
  });

  it('is info (not warning) between 60% and 85%', () => {
    const r = portfolioRecommendations(
      metrics({ concentration: { token: 't', symbol: 'T', pct: 70 } }),
    );
    expect(r[0]?.severity).toBe('info');
  });

  it('says nothing for a diversified portfolio', () => {
    expect(
      portfolioRecommendations(metrics({ concentration: { token: 't', symbol: 'T', pct: 40 } })),
    ).toEqual([]);
    expect(portfolioRecommendations(metrics({ concentration: null }))).toEqual([]);
  });
});
