import { describe, expect, it } from 'vitest';
import { rankOpportunities, type PoolInput } from '../src/analytics/opportunities';

const NOW = new Date('2026-11-07T12:00:00Z');
const symbols = new Map([
  ['wrap.near', 'wNEAR'],
  ['usdc.near', 'USDC'],
  ['usdt.near', 'USDt'],
  ['meme.near', 'MEME'],
]);
const pool = (
  key: string,
  tvl: number,
  apr: number,
  over: Partial<PoolInput> & { history?: number } = {},
): PoolInput => ({
  poolKey: key,
  family: 'v1',
  poolType: 'SIMPLE_POOL',
  tokens: ['wrap.near', 'usdc.near'],
  feeBps: 30,
  tvlUsd: String(tvl),
  priceQuality: 'OK',
  category: 'LP_SIMULATION_ELIGIBLE',
  active: true,
  lastSeenAt: NOW,
  latest: {
    historySeconds: over.history ?? 30 * 86_400,
    windows: [
      {
        window: '30D',
        annualizedApr: String(apr),
        volumeUsd: '1000',
        realizedYield: null,
        quality: 'OK',
      },
    ],
  },
  ...over,
});
const rank = (pools: PoolInput[], lp: { poolKey: string; netReturnPct: string }[] = []) =>
  rankOpportunities({
    pools,
    markets: [],
    simulations: [
      {
        portfolioId: 'demo-5000',
        capitalUsd: 1700,
        lp: lp.map((x) => ({
          ...x,
          status: 'OK',
          horizonDays: 30,
          expectedFeesUsd: null,
          impermanentLossUsd: null,
          entryCostUsd: null,
          exitCostUsd: null,
          gasUsd: null,
          window: '30D',
        })),
      },
    ],
    symbols,
    now: NOW,
    intervalSeconds: 900,
  });

describe('opportunity ranking', () => {
  it('a huge APR on thin liquidity never outranks a deep, priced pool', () => {
    const { opportunities } = rank([
      pool('v1:thin', 12_000, 3.5, { tokens: ['meme.near', 'wrap.near'] }),
      pool('v1:deep', 2_000_000, 0.12),
    ]);
    expect(opportunities.map((o) => o.ref)).toEqual(['v1:deep', 'v1:thin']);
    expect(opportunities[1]).toMatchObject({ status: 'watch' });
    expect(opportunities[1]?.why).toMatch(/liquidity is below \$50k/);
  });

  it('a pool whose stored simulation loses money after costs is never a candidate', () => {
    const { opportunities } = rank(
      [pool('v1:a', 500_000, 0.1)],
      [{ poolKey: 'v1:a', netReturnPct: '-0.8' }],
    );
    expect(opportunities[0]).toMatchObject({ status: 'watch' });
    expect(opportunities[0]?.netApr).toBeCloseTo(-0.008 * (365 / 30), 6);
  });

  it('net yield exists only from a stored simulation; otherwise it is null, never estimated', () => {
    const { opportunities } = rank([pool('v1:a', 500_000, 0.1)]);
    expect(opportunities[0]?.netApr).toBeNull();
    expect(opportunities[0]?.limitations).toContain('net yield not simulated for this pool');
  });

  it('unconfirmed prices and unsupported or illiquid pools are excluded or downgraded, with a reason', () => {
    const { opportunities, excluded } = rank([
      pool('v1:low', 900_000, 0.2, { priceQuality: 'LOW_CONFIDENCE' }),
      pool('v1:unsupported', 900_000, 0.2, { category: 'UNSUPPORTED' }),
      pool('v1:dust', 10, 0.2, { category: 'LOW_LIQUIDITY' }),
    ]);
    expect(opportunities.map((o) => [o.ref, o.status])).toEqual([['v1:low', 'watch']]);
    expect(excluded).toEqual({
      'Rhea: pool model not supported yet': 1,
      'Rhea: too little liquidity': 1,
    });
  });

  it('is deterministic for the same input', () => {
    const input = [pool('v1:a', 500_000, 0.1), pool('v1:b', 800_000, 0.08)];
    expect(rank(input)).toEqual(rank(input));
  });
});
