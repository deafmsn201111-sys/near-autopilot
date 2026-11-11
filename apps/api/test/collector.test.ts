import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAnalyticsServer } from '../src/analytics/server';
import { registryScanDue } from '../src/collector/collector';
import { feeWindow, volumeUsdBetween, type PoolPoint } from '../src/collector/history';
import { impermanentLoss, simulateLpEntry, swapCostUsd, swapOut } from '../src/collector/lp';
import { DEFAULT_FILTER, type DiscoveredPool, type TokenPrice } from '../src/collector/model';
import { longTailPrices } from '../src/collector/prices';
import { classifyPool } from '../src/collector/rhea-discovery';
import type { CollectorStore } from '../src/collector/store';
import { formatDecimal, parseDecimal, type Decimal } from '../src/market-data/decimal';
import { HttpJsonClient } from '../src/market-data/http';

const NEAR = 'wrap.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const MEME = 'meme.tkn.near';
const d = (s: string) => parseDecimal(s) as Decimal;
const price = (usd: string, quality: TokenPrice['quality'] = 'OK'): TokenPrice => ({
  usd: d(usd),
  quality,
  source: 'defillama',
  sourceAssetId: 'x',
});
const DECIMALS = new Map<string, number | null>([
  [NEAR, 24],
  [USDC, 6],
  [MEME, 18],
]);
const PRICES = new Map<string, TokenPrice>([
  [NEAR, price('4')],
  [USDC, price('1')],
]);
const pool = (over: Partial<DiscoveredPool> = {}): DiscoveredPool => ({
  poolKey: 'v1:4512',
  family: 'v1',
  contract: 'v2.ref-finance.near',
  poolType: 'SIMPLE_POOL',
  tokens: [USDC, NEAR],
  reserves: [1_000_000n * 10n ** 6n, 250_000n * 10n ** 24n], // $1M / $1M, price 4.00 = reference
  feeBps: 30,
  volumesIn: [0n, 0n],
  state: 'Running',
  raw: {},
  ...over,
});
const classify = (p: DiscoveredPool, over: Partial<Parameters<typeof classifyPool>[0]> = {}) =>
  classifyPool({
    pool: p,
    decimals: DECIMALS,
    prices: PRICES,
    filter: DEFAULT_FILTER,
    historySeconds: 0,
    windowVolumeUsd: null,
    ...over,
  });

describe('Rhea pool classification', () => {
  it('a deep, correctly priced SIMPLE_POOL needs history before analytics, and volume before LP simulation', () => {
    expect(classify(pool()).category).toBe('LIQUID');
    expect(classify(pool()).reasons.map((r) => r.code)).toEqual(['INSUFFICIENT_HISTORY']);
    expect(classify(pool(), { historySeconds: 3_600 }).category).toBe('ANALYTICS_ELIGIBLE');
    expect(classify(pool(), { historySeconds: 3_600, windowVolumeUsd: d('5000') }).category).toBe(
      'LP_SIMULATION_ELIGIBLE',
    );
    expect(classify(pool()).tvlUsd && classify(pool()).tvlUsd?.mantissa).toBeTruthy();
  });

  it('never applies the Simple Pool model to DCL / stable / degen pools', () => {
    for (const p of [
      pool({ poolKey: 'dcl:x', family: 'dcl', poolType: 'DCL' }),
      pool({ poolType: 'DEGEN_SWAP' }),
      pool({ poolType: 'STABLE_SWAP' }),
    ]) {
      const c = classify(p, { historySeconds: 86_400, windowVolumeUsd: d('1e6') });
      expect(c.category).toBe('UNSUPPORTED');
      expect(c.modelStatus).toBe('UNSUPPORTED_POOL_MODEL');
      expect(c.tracked).toBe(true); // liquid: history is still collected
    }
  });

  it('empty, inactive, thin, unpriced and mispriced pools', () => {
    expect(classify(pool({ reserves: [0n, 1n] })).category).toBe('LOW_LIQUIDITY');
    expect(classify(pool({ reserves: [0n, 1n] })).reasons[0]?.code).toBe('EMPTY_POOL');
    expect(classify(pool({ state: 'Paused' })).category).toBe('DATA_INVALID');
    expect(classify(pool({ reserves: [1_000n * 10n ** 6n, 250n * 10n ** 24n] })).category).toBe(
      'LOW_LIQUIDITY',
    );
    const unpriced = classify(pool({ tokens: [MEME, 'other.near'] }));
    expect(unpriced.category).toBe('DISCOVERED');
    expect(unpriced.tvlUsd).toBeNull(); // unknown value is never 0
    // Pool price 2x the reference: never analytics-eligible.
    const skewed = classify(pool({ reserves: [2_000_000n * 10n ** 6n, 250_000n * 10n ** 24n] }), {
      historySeconds: 86_400,
      windowVolumeUsd: d('1e6'),
    });
    expect(skewed.category).toBe('LIQUID');
    expect(skewed.reasons.map((r) => r.code)).toContain('PRICE_DEVIATION');
  });

  it('low-confidence or one-sided prices may only place a pool for discovery', () => {
    const one = classify(
      pool({ tokens: [MEME, NEAR], reserves: [10n ** 30n, 250_000n * 10n ** 24n] }),
      { historySeconds: 86_400, windowVolumeUsd: d('1e6') },
    );
    expect(one.tvlMethod).toBe('priced_side_x2');
    expect(one.priceQuality).toBe('LOW_CONFIDENCE');
    expect(one.category).toBe('LIQUID');
    const low = new Map(PRICES);
    low.set(USDC, price('1', 'LOW_CONFIDENCE'));
    expect(
      classify(pool(), { prices: low, historySeconds: 86_400, windowVolumeUsd: d('1e6') }).category,
    ).toBe('LIQUID');
  });
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 0, 0, s));
const pt = (h: number, s: number, vol: [string, string], tvl = '2000000'): PoolPoint => ({
  blockHeight: h,
  at: at(s),
  reserves: ['1000000000000', '250000000000000000000000000000'],
  volumesIn: vol,
  feeBps: 30,
  adminFeeBps: 2_000,
  tvlUsd: tvl,
});

describe('registry rescan schedule', () => {
  const now = new Date('2026-11-05T02:25:00Z');
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000);
  it('scans first, then every 4th cycle, and also after downtime longer than 4 intervals', () => {
    expect(registryScanDue(null, 4, 3600, now)).toBe(true);
    expect(registryScanDue({ cycles: 1, lastAt: minsAgo(30) }, 4, 3600, now)).toBe(false);
    expect(registryScanDue({ cycles: 3, lastAt: minsAgo(45) }, 4, 3600, now)).toBe(true);
    // Docker was down for hours: only one cycle since the scan, but it is stale.
    expect(registryScanDue({ cycles: 1, lastAt: minsAgo(240) }, 4, 3600, now)).toBe(true);
  });
});

describe('history volume for LP eligibility', () => {
  it('is computed without a pool value (the current reading is not valued yet) and fails closed', () => {
    const first = pt(1, 0, ['0', '0']);
    const current = { ...pt(2, 40_000, ['57000000000', '0']), tvlUsd: null }; // 57,000 USDC in, not yet valued
    const volume = volumeUsdBetween(first, current, [USDC, NEAR], DECIMALS, PRICES);
    expect(volume && formatDecimal(volume)).toBe('57000');
    // ...and it makes the pool LP_SIMULATION_ELIGIBLE under the unchanged criteria.
    expect(classify(pool(), { historySeconds: 40_000, windowVolumeUsd: volume }).category).toBe(
      'LP_SIMULATION_ELIGIBLE',
    );
    // A registry-scan reading without volumes, a decreasing volume or an unpriced token gives no volume.
    expect(
      volumeUsdBetween({ ...first, volumesIn: null }, current, [USDC, NEAR], DECIMALS, PRICES),
    ).toBeNull();
    expect(
      volumeUsdBetween(pt(1, 0, ['9', '0']), pt(2, 9, ['8', '0']), [USDC, NEAR], DECIMALS, PRICES),
    ).toBeNull();
    expect(volumeUsdBetween(first, current, [USDC, NEAR], DECIMALS, new Map())).toBeNull();
  });
});

describe('fee windows', () => {
  const now = at(3_700);
  it('24H window without 24 h of data is INSUFFICIENT_HISTORY; 1H is computed with gross/admin/LP split', () => {
    const points = [pt(1, 0, ['0', '0']), pt(2, 3_600, ['1000000000', '0'])]; // 1,000 USDC in
    expect(feeWindow('24H', points, [USDC, NEAR], DECIMALS, PRICES, now, 3_600).quality).toBe(
      'INSUFFICIENT_HISTORY',
    );
    const w = feeWindow('1H', points, [USDC, NEAR], DECIMALS, PRICES, now, 3_600);
    expect(w.quality).toBe('OK');
    expect(w.volumeUsd).toBe('1000');
    expect(w.grossFeesUsd).toBe('3');
    expect(w.adminFeesUsd).toBe('0.6');
    expect(w.lpFeesUsd).toBe('2.4');
    expect(w.realizedYield).toBe('0.0000012'); // 2.4 / 2,000,000, NOT annualised
    expect(Number(w.annualizedApr)).toBeCloseTo(0.010512, 6); // x 8760
    expect(w.confidence).toBe('LOW');
  });
  it('rejects broken sequences, decreasing volumes, fee changes, stale data and unpriced tokens', () => {
    const ok = [pt(1, 0, ['0', '0']), pt(2, 3_600, ['10', '0'])];
    expect(
      feeWindow(
        '1H',
        [pt(1, 0, ['10', '0']), pt(2, 3_600, ['5', '0'])],
        [USDC, NEAR],
        DECIMALS,
        PRICES,
        now,
        3_600,
      ).quality,
    ).toBe('DATA_INVALID');
    expect(feeWindow('1H', ok, [USDC, NEAR], DECIMALS, PRICES, now, 3_600, true).quality).toBe(
      'DATA_INVALID',
    );
    expect(
      feeWindow(
        '1H',
        [ok[0] as PoolPoint, { ...(ok[1] as PoolPoint), feeBps: 25 }],
        [USDC, NEAR],
        DECIMALS,
        PRICES,
        now,
        3_600,
      ).quality,
    ).toBe('DATA_INVALID');
    expect(feeWindow('1H', ok, [USDC, NEAR], DECIMALS, PRICES, at(20_000), 3_600).quality).toBe(
      'STALE_DATA',
    );
    expect(feeWindow('1H', ok, [USDC, NEAR], DECIMALS, new Map(), now, 3_600).quality).toBe(
      'LOW_CONFIDENCE',
    );
    expect(feeWindow('1H', [], [USDC, NEAR], DECIMALS, PRICES, now, 3_600).quality).toBe(
      'INSUFFICIENT_HISTORY',
    );
  });
  it('window figures stay readable: long TVL and price digits do not overflow parseDecimal', () => {
    // Live regression (pool v1:4512): annualizedApr was written with 68 fractional digits, which
    // parseDecimal (cap 60) rejected, so the LP simulation reported "fee window incomplete".
    const tvl = '1958053.314072817217405372267099256136';
    const prices = new Map<string, TokenPrice>([
      [NEAR, price('1.873219876543210987654321')],
      [USDC, price('0.999876543210987654321')],
    ]);
    const w = feeWindow(
      '1H',
      [
        pt(1, 0, ['0', '0'], tvl),
        pt(2, 3_607, ['123456789123', '98765432109876543210987654'], tvl),
      ],
      [USDC, NEAR],
      DECIMALS,
      prices,
      at(3_700),
      3_600,
    );
    expect(w.quality).toBe('OK');
    for (const v of [
      w.volumeUsd,
      w.lpFeesUsd,
      w.avgTvlUsd,
      w.endTvlUsd,
      w.realizedYield,
      w.annualizedApr,
    ]) {
      expect(v).not.toBeNull();
      expect(parseDecimal(v as string)).not.toBeNull();
      expect((v as string).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(18);
    }
  });
});

describe('LP entry math', () => {
  it('impermanent loss of a constant-product position', () => {
    expect(impermanentLoss(1)).toBe(0);
    expect(impermanentLoss(4)).toBeCloseTo(-0.2, 10); // 2*2/5 - 1
    expect(impermanentLoss(1.21)).toBeCloseTo(-0.0045248869, 8); // 2*1.1/2.21 - 1
    expect(() => impermanentLoss(0)).toThrow();
  });
  it('constant-product swap with fee; cost of swapping is fee + impact', () => {
    expect(swapOut(1_000n, 1_000_000n, 1_000_000n, 30)).toBe(996n);
    const cost = swapCostUsd(
      100,
      [250_000n * 10n ** 24n, 1_000_000n * 10n ** 6n],
      30,
      [24, 6],
      [d('4'), d('1')],
    );
    expect(cost).toBeGreaterThan(0.3); // 0.30 % fee on $100
    expect(cost).toBeLessThan(0.32); // + tiny impact in a $2M pool
  });
  const windows = [
    feeWindow(
      '1H',
      [pt(1, 0, ['0', '0']), pt(2, 3_600, ['1000000000', '0'])],
      [USDC, NEAR],
      DECIMALS,
      PRICES,
      at(3_700),
      3_600,
    ),
  ];
  const sim = (over: Partial<Parameters<typeof simulateLpEntry>[0]> = {}) =>
    simulateLpEntry({
      poolKey: 'v1:4512',
      tokens: [USDC, NEAR],
      reserves: [1_000_000n * 10n ** 6n, 250_000n * 10n ** 24n],
      feeBps: 30,
      decimals: DECIMALS,
      prices: PRICES,
      capitalUsd: 1_000,
      horizonDays: 30,
      gasUsdPerTx: 0.05,
      windows,
      rawRatioRange: { min: 0.25e18 * 0.99, max: 0.25e18 * 1.01, samples: 2 },
      ...over,
    });
  it('net = fees - IL - entry - exit - gas; rewards are never assumed', () => {
    const s = sim();
    expect(s.status).toBe('OK');
    const net =
      Number(s.expectedFeesUsd) -
      Number(s.impermanentLossUsd) -
      Number(s.entryCostUsd) -
      Number(s.exitCostUsd) -
      Number(s.gasUsd);
    expect(Number(s.netReturnUsd)).toBeCloseTo(net, 5);
    expect(s.rewardsUsd).toBe('0');
    expect(Number(s.gasUsd)).toBeCloseTo(0.2, 10);
    expect(Number(s.impermanentLossUsd)).toBeGreaterThan(0);
    expect(s.risks.join(' ')).toContain('min of history');
  });
  it('INSUFFICIENT_DATA without OK prices or a fee window; LOW confidence without a price range', () => {
    expect(sim({ windows: [] }).status).toBe('INSUFFICIENT_DATA');
    const low = new Map(PRICES);
    low.set(NEAR, price('4', 'LOW_CONFIDENCE'));
    expect(sim({ prices: low }).status).toBe('INSUFFICIENT_DATA');
    expect(sim({ rawRatioRange: null }).confidence).toBe('LOW');
  });
});

describe('long-tail prices (DefiLlama near:<contract>)', () => {
  const nowS = 1_793_900_000;
  const http = (body: unknown, status = 200) =>
    new HttpJsonClient({
      fetchImpl: async () => new Response(JSON.stringify(body), { status }),
      sleep: async () => {},
    });
  it('>= 0.9 confidence is OK, lower is LOW_CONFIDENCE, stale or < 0.5 is not used, absent is unpriced', async () => {
    const r = await longTailPrices(
      http({
        coins: {
          'near:a.near': { price: 2, timestamp: nowS - 10, confidence: 0.99, decimals: 18 },
          'near:b.near': { price: 3, timestamp: nowS - 10, confidence: 0.7 },
          'near:c.near': { price: 3, timestamp: nowS - 100_000, confidence: 0.99 },
          'near:d.near': { price: 3, timestamp: nowS - 10, confidence: 0.2 },
          'near:e.near': { price: 0, timestamp: nowS - 10, confidence: 0.99 },
        },
      }),
      'https://llama.test',
      ['a.near', 'b.near', 'c.near', 'd.near', 'e.near', 'f.near'],
      new Date(nowS * 1000),
    );
    expect(r.prices.get('a.near')?.quality).toBe('OK');
    expect(r.reportedDecimals.get('a.near')).toBe(18);
    expect(r.prices.get('b.near')?.quality).toBe('LOW_CONFIDENCE');
    for (const t of ['c.near', 'd.near', 'e.near', 'f.near']) expect(r.prices.has(t)).toBe(false);
    expect(r.observations.find((o) => o.contract === 'c.near')?.status).toBe('stale');
  });
  it('age is measured when the answer arrived, not at the cycle start (a long cycle fetches later)', async () => {
    const cycleStart = new Date(nowS * 1000);
    const arrived = new Date((nowS + 25) * 1000); // a registry-scan cycle: 25 s after the start
    const r = await longTailPrices(
      http({ coins: { 'near:a.near': { price: 2, timestamp: nowS + 20, confidence: 0.99 } } }),
      'https://llama.test',
      ['a.near'],
      cycleStart,
      undefined,
      () => arrived,
    );
    // published 5 s before it arrived: fresh, not "from the future"
    expect(r.observations[0]).toMatchObject({ status: 'valid', ageMs: 5_000, fetchedAt: arrived });
    // and a genuinely future timestamp (beyond 5 s skew at arrival) is still refused
    const later = await longTailPrices(
      http({ coins: { 'near:a.near': { price: 2, timestamp: nowS + 40, confidence: 0.99 } } }),
      'https://llama.test',
      ['a.near'],
      cycleStart,
      undefined,
      () => arrived,
    );
    expect(later.observations[0]?.status).toBe('future');
  });
  it('a failed batch loses only its own tokens and is counted', async () => {
    const r = await longTailPrices(
      http({ error: 'x' }, 500),
      'https://llama.test',
      ['a.near'],
      new Date(nowS * 1000),
    );
    expect(r.failures).toBe(1);
    expect(r.prices.size).toBe(0);
  });
});

describe('read-only analytics API', () => {
  const store = {
    recentCycles: async () => [],
    latestSnapshot: async () => null,
    pools: async () => [],
    markets: async () => [],
    analysesForSnapshot: async () => [],
  } as unknown as CollectorStore;
  const app = buildAnalyticsServer({
    apiToken: 'token-token-token-token-token-token',
    store,
    intervalSeconds: 900,
  });
  it('requires the token, serves the banner, and has no write route', async () => {
    expect((await app.inject('/v1/analytics/overview')).statusCode).toBe(401);
    const ok = await app.inject({
      url: '/v1/analytics/overview',
      headers: { authorization: 'Bearer token-token-token-token-token-token' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ banner: string }>().banner).toBe(
      'SHADOW MODE — MAINNET READ-ONLY — NO TRANSACTIONS',
    );
    for (const method of ['POST', 'PUT', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: '/v1/analytics/overview',
            headers: { authorization: 'Bearer token-token-token-token-token-token' },
          })
        ).statusCode,
      ).toBe(404);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });
});

describe('collector and analytics code: no signing, no sending; the LLM only behind its port', () => {
  const dir = (p: string) =>
    readdirSync(new URL(p, import.meta.url)).map((f) =>
      join(new URL(p, import.meta.url).pathname, f),
    );
  const files = [...dir('../src/collector/'), ...dir('../src/analytics/')];
  // Architecture C: only the analytics entry point wires the LLM provider; everything else sees the ToolLlm port.
  const wiresLlm = (file: string) => file.endsWith('/analytics/main.ts');
  it.each(files)('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    if (!wiresLlm(file)) expect(src).not.toMatch(/anthropic|openai|LlmClient|claude/i);
    expect(src).not.toMatch(
      /broadcast|send_tx|signTransaction|sendTransaction|NearKeyPairSigner|loadSigner/,
    );
  });
});
