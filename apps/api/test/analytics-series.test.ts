import { describe, expect, it } from 'vitest';
import { consensus, range24hBps, riskBands } from '../src/analytics/series';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';

const TOKEN = 'series-token-series-token-series-token-1';
const auth = { authorization: `Bearer ${TOKEN}` };
const q = (source: string, priceUsd: string | null, status = 'valid', quoteCurrency = 'USD') => ({
  source,
  priceUsd,
  status,
  quoteCurrency,
});

describe('consensus of one snapshot', () => {
  it('uses only valid USD quotes: median price, widest pairwise spread', () => {
    expect(
      consensus([
        q('pyth', '3.00'),
        q('defillama', '3.03'),
        q('coinbase', '3.01'),
        q('binance', '9.99', 'valid', 'USDT'), // quoted in USDT: not compared as USD
        q('kraken', '1.00', 'stale'), // rejected quote: ignored
      ]),
    ).toEqual({ price: 3.01, spreadBps: 100, sources: 3 });
  });
  it('one source has no spread; none has no price (never 0)', () => {
    expect(consensus([q('defillama', '2.5')])).toEqual({ price: 2.5, spreadBps: null, sources: 1 });
    expect(consensus([q('pyth', null, 'unavailable')])).toEqual({
      price: null,
      spreadBps: null,
      sources: 0,
    });
  });
});

describe('24h range from the collector prices', () => {
  const HOUR = 60 * 60 * 1000;
  const snaps = (prices: readonly number[], stepMs = 2 * HOUR) =>
    prices.flatMap((p, i) => {
      const at = { snapshotId: `s${i}`, observedAt: new Date(i * stepMs) };
      return [
        { ...at, ...q('pyth', String(p)) },
        { ...at, ...q('kraken', '1.00', 'stale') },
      ];
    });
  it('is (high - low) / low of the per-snapshot consensus, in bps', () => {
    expect(range24hBps(snaps([1, 1.2, ...Array<number>(10).fill(1.1), 1.4]))).toBe(4000);
  });
  it('needs 12 priced snapshots: fewer is not a 24h range', () => {
    expect(range24hBps(snaps(Array<number>(11).fill(2)))).toBeNull();
    expect(range24hBps(snaps(Array<number>(12).fill(2)))).toBe(0);
  });
  it('needs the snapshots to span 12 h: a fast collector after a restart is not a 24h range', () => {
    expect(range24hBps(snaps(Array<number>(48).fill(2), 15 * 60 * 1000))).toBeNull();
    expect(range24hBps(snaps(Array<number>(49).fill(2), 15 * 60 * 1000))).toBe(0);
  });
  it('an unpriced snapshot does not stretch the span', () => {
    const unpriced = {
      snapshotId: 'old',
      observedAt: new Date(-23 * HOUR),
      ...q('pyth', null, 'stale'),
    };
    expect(
      range24hBps([unpriced, ...snaps([1, ...Array<number>(11).fill(1.3)], 60_000)]),
    ).toBeNull();
  });
});

describe('risk bands', () => {
  it("are the orchestrator's defaults unless overridden", () => {
    expect(riskBands()).toEqual({
      watch: 1.5,
      danger: 1.1,
      critical: 1.05,
      target: 1.6,
      liquidation: 1,
    });
    expect(riskBands({ watchBelowBps: 14_000, targetHealthFactorBps: 17_000 }).watch).toBe(1.4);
  });
});

describe('GET /v1/analytics/risk', () => {
  const hf = (x: number) => (BigInt(Math.round(x * 1e6)) * 10n ** 12n).toString();
  const at = (m: number) => new Date(Date.UTC(2026, 10, 6, 12, m));
  const store = {
    riskSeries: async () => [
      {
        portfolioId: 'demo-500',
        at: at(0),
        risk: { level: 'healthy', healthFactorWad: hf(1.7) },
        description: 'd',
      },
      {
        portfolioId: 'demo-500',
        at: at(15),
        description: 'd',
        risk: {
          level: 'healthy',
          healthFactorWad: hf(1.6),
          ltvBps: '4400',
          collateralUsdMicro: '450000000',
          debtUsdMicro: '200000000',
          stress: [
            { scenario: 'collateral -50%', status: 'liquidatable', healthFactorWad: hf(0.8) },
          ],
        },
      },
    ],
  } as unknown as CollectorStore;

  it('returns the stored engine results, labelled simulated, with the exact liquidation distance', async () => {
    const app = buildAnalyticsServer({ apiToken: TOKEN, store, intervalSeconds: 900 });
    const res = await app.inject({ url: '/v1/analytics/risk', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      dataSource: string;
      label: string;
      portfolios: {
        portfolioId: string;
        latest: { healthFactor: number; collateralDropToLiquidation: number; stress: unknown[] };
        history: { healthFactor: number }[];
      }[];
    }>();
    expect(body.dataSource).toBe('simulation');
    expect(body.label).toMatch(/SIMULATED/);
    const [p] = body.portfolios;
    expect(p?.history.map((h) => h.healthFactor)).toEqual([1.7, 1.6]);
    expect(p?.latest.healthFactor).toBe(1.6);
    // HF 1.6: a uniform collateral fall of 1 - 1/1.6 = 37.5 % brings it to 1.0
    expect(p?.latest.collateralDropToLiquidation).toBeCloseTo(0.375, 9);
    expect(p?.latest.stress).toEqual([
      { scenario: 'collateral -50%', status: 'liquidatable', healthFactor: 0.8 },
    ]);
    await app.close();
  });

  it('needs the token', async () => {
    const app = buildAnalyticsServer({ apiToken: TOKEN, store, intervalSeconds: 900 });
    expect((await app.inject({ url: '/v1/analytics/risk' })).statusCode).toBe(401);
    await app.close();
  });

  it('serves no operator controls: the API is read-only', async () => {
    const app = buildAnalyticsServer({ apiToken: TOKEN, store, intervalSeconds: 900 });
    const calls = [
      { method: 'GET', url: '/v1/control' },
      { method: 'POST', url: '/v1/control/collector/run' },
      { method: 'POST', url: '/v1/control/mode' },
    ] as const;
    for (const c of calls)
      expect((await app.inject({ ...c, headers: auth })).statusCode, c.url).toBe(404);
    await app.close();
  });
});
