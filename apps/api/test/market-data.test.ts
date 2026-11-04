import { describe, expect, it } from 'vitest';
import type { TokenId } from '@near-autopilot/core';
import { ReferenceMarketProvider, ReferencePriceOracle } from '../src/market-data/adapters';
import { REFERENCE_ASSETS, type ReferenceAsset } from '../src/market-data/assets';
import {
  decimalFromJsonNumber,
  deviationBps,
  formatDecimal,
  parseDecimal,
  toUnitPrice,
} from '../src/market-data/decimal';
import { HttpJsonClient, MarketHttpError } from '../src/market-data/http';
import {
  REFERENCE_LABEL,
  type MarketReport,
  type PriceObservation,
} from '../src/market-data/model';
import { ReferenceMarketData, resolveAsset } from '../src/market-data/service';
import { DefiLlamaSource, PythSource } from '../src/market-data/sources';

const NOW = new Date('2026-11-04T12:00:00Z');
const nowS = NOW.getTime() / 1000;
const asset = (token: string): ReferenceAsset => {
  const a = REFERENCE_ASSETS.find((x) => x.testnetToken === token);
  if (!a) throw new Error(token);
  return a;
};
const NEAR = asset('wrap.testnet');
const USDT = asset('usdt.fakes.testnet');

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Routes requests by URL substring; records every URL and Authorization header seen. */
function fakeFetch(routes: Array<[string, () => Response]>) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('authorization') });
    const route = routes.find(([k]) => url.includes(k));
    if (!route) return new Response('not found', { status: 404 });
    return route[1]();
  };
  return { impl, calls };
}

const noSleep = { sleep: async () => {}, random: () => 0.5 };

const pythFeeds = () =>
  json(
    REFERENCE_ASSETS.flatMap((a) =>
      a.pyth
        ? [{ id: a.pyth.feedId, attributes: { symbol: a.pyth.symbol, quote_currency: 'USD' } }]
        : [],
    ),
  );
const pythLatest = (
  over: Partial<Record<string, { price: string; conf?: string; t?: number }>> = {},
) =>
  json({
    parsed: REFERENCE_ASSETS.flatMap((a) => {
      if (!a.pyth) return [];
      const o = over[a.testnetToken] ?? { price: a === NEAR ? '398000000' : '99990000' };
      return [
        {
          id: a.pyth.feedId,
          price: {
            price: o.price,
            conf: o.conf ?? '100000',
            expo: -8,
            publish_time: o.t ?? nowS - 2,
          },
        },
      ];
    }),
  });
const llamaCoins = (
  over: Record<
    string,
    Partial<{
      price: number;
      timestamp: number;
      confidence: number;
      decimals: number;
      symbol: string;
    }> | null
  > = {},
) => {
  const base: Record<
    string,
    { price: number; symbol: string; timestamp: number; confidence: number; decimals?: number }
  > = {
    'coingecko:near': { price: 3.99, symbol: 'NEAR', timestamp: nowS - 20, confidence: 0.99 },
    'near:wrap.near': {
      price: 4.0,
      symbol: 'wNEAR',
      timestamp: nowS - 30,
      confidence: 0.99,
      decimals: 24,
    },
    'coingecko:tether': { price: 0.99876, symbol: 'USDT', timestamp: nowS - 10, confidence: 0.99 },
    'near:dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near': {
      price: 0.999,
      symbol: 'USDT.e',
      timestamp: nowS - 10,
      confidence: 0.7,
      decimals: 6,
    },
    'coingecko:usd-coin': { price: 0.9998, symbol: 'USDC', timestamp: nowS - 10, confidence: 0.99 },
    'near:a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near': {
      price: 0.9994,
      symbol: 'USDC.e',
      timestamp: nowS - 10,
      confidence: 0.7,
      decimals: 6,
    },
  };
  const coins: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    const o = over[k];
    if (o === null) continue;
    coins[k] = { ...v, ...o };
  }
  return json({ coins });
};

const obs = (
  source: 'pyth' | 'defillama',
  price: string,
  status: PriceObservation['status'] = 'valid',
): PriceObservation => ({
  source,
  network: 'mainnet',
  assetId: `${source}-id`,
  contract: null,
  priceUsd: parseDecimal(price),
  quoteCurrency: 'USD',
  confidence: null,
  publishedAt: NOW,
  fetchedAt: NOW,
  ageMs: 0,
  status,
  reason: status === 'valid' ? null : status,
});

describe('decimal', () => {
  it('parses and formats exactly, without float arithmetic', () => {
    expect(formatDecimal(parseDecimal('3.986570184437296')!)).toBe('3.986570184437296');
    expect(formatDecimal(parseDecimal('1e-7')!)).toBe('0.0000001');
    expect(formatDecimal(decimalFromJsonNumber(0.1 + 0.2)!)).toBe('0.30000000000000004'); // the literal, not "0.3"
    expect(parseDecimal('abc')).toBeNull();
    expect(decimalFromJsonNumber(Number.NaN)).toBeNull();
  });
  it('converts USD per token to the core per-raw-unit price, exactly', () => {
    // 3.98 USD per NEAR (24 decimals): 1 NEAR raw = 10^24 -> 398 / 10^26 per raw unit.
    expect(toUnitPrice(parseDecimal('3.98')!, 24)).toEqual({ multiplier: 398n, decimals: 26 });
    expect(toUnitPrice(parseDecimal('1')!, 6)).toEqual({ multiplier: 1n, decimals: 6 });
    expect(() => toUnitPrice(parseDecimal('0')!, 6)).toThrow(RangeError);
    expect(deviationBps(parseDecimal('4')!, parseDecimal('3.96')!)).toBe(101n);
  });
});

describe('resolveAsset (consensus)', () => {
  it('two providers within the limit: corroborated, Pyth (priority) chosen, DefiLlama cross-check', () => {
    const r = resolveAsset(NEAR, [obs('pyth', '3.98'), obs('defillama', '3.99')], 24);
    expect(r.status).toBe('corroborated');
    expect(r.chosen?.source).toBe('pyth');
    expect(r.crossCheck?.source).toBe('defillama');
    expect(r.label).toBe(REFERENCE_LABEL);
  });
  it('fallback: Pyth unavailable -> DefiLlama alone, flagged single_source', () => {
    const r = resolveAsset(NEAR, [obs('pyth', '0', 'unavailable'), obs('defillama', '3.99')], 24);
    expect(r.status).toBe('single_source');
    expect(r.chosen?.source).toBe('defillama');
  });
  it('sources disagree beyond the limit: price_disputed, no price', () => {
    const r = resolveAsset(NEAR, [obs('pyth', '3.98'), obs('defillama', '4.20')], 24);
    expect(r.status).toBe('price_disputed');
    expect(r.priceUsd).toBeNull();
    expect(r.reason).toContain('excluded');
  });
  it('stale / invalid / no observation: unpriced with every reason, never a zero price', () => {
    const r = resolveAsset(
      USDT,
      [obs('pyth', '1', 'stale'), obs('defillama', '1', 'low_confidence')],
      6,
    );
    expect(r.status).toBe('unpriced');
    expect(r.priceUsd).toBeNull();
    expect(r.reason).toContain('stale');
    expect(r.reason).toContain('low_confidence');
  });
  it('testnet decimals differing from the mapping: unpriced even with valid prices', () => {
    const r = resolveAsset(USDT, [obs('pyth', '1'), obs('defillama', '1')], 18);
    expect(r.status).toBe('unpriced');
    expect(r.reason).toContain('decimals 18');
    expect(resolveAsset(USDT, [obs('pyth', '1')], null).status).toBe('unpriced');
  });
});

describe('PythSource', () => {
  it('without PYTH_API_KEY it is unavailable and makes no request', async () => {
    const f = fakeFetch([]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: undefined,
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(REFERENCE_ASSETS, NOW);
    expect(r.status.health).toBe('unavailable');
    expect(f.calls).toHaveLength(0);
    expect(r.observations.get('wrap.testnet')?.[0]?.status).toBe('unavailable');
  });
  it('verifies feed ids, sends the key as a bearer header, and parses exact integer prices', async () => {
    const f = fakeFetch([
      ['/v2/price_feeds', pythFeeds],
      ['/v2/updates/price/latest', () => pythLatest()],
    ]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'test-key-123',
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(REFERENCE_ASSETS, NOW);
    const near = r.observations.get('wrap.testnet')?.[0];
    expect(near?.status).toBe('valid');
    expect(formatDecimal(near!.priceUsd!)).toBe('3.98');
    expect(near?.network).toBe('mainnet');
    expect(f.calls.find((c) => c.url.includes('/latest'))?.auth).toBe('Bearer test-key-123');
    expect(
      f.calls.filter((c) => c.url.includes('/price_feeds')).every((c) => c.auth === null),
    ).toBe(true);
  });
  it('rejects a feed id whose metadata symbol does not match, and stale / wide-confidence prices', async () => {
    const f = fakeFetch([
      [
        '/v2/price_feeds',
        () =>
          json([
            { id: NEAR.pyth!.feedId, attributes: { symbol: 'Crypto.OTHER/USD' } },
            { id: USDT.pyth!.feedId, attributes: { symbol: USDT.pyth!.symbol } },
            {
              id: asset('usdc.fakes.testnet').pyth!.feedId,
              attributes: { symbol: 'Crypto.USDC/USD' },
            },
          ]),
      ],
      [
        '/v2/updates/price/latest',
        () =>
          pythLatest({
            'usdt.fakes.testnet': { price: '99990000', t: nowS - 600 },
            'usdc.fakes.testnet': { price: '100000000', conf: '50000000' },
          }),
      ],
    ]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'k-12345678',
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(REFERENCE_ASSETS, NOW);
    expect(r.observations.get('wrap.testnet')?.[0]?.status).toBe('mapping_mismatch');
    expect(r.observations.get('usdt.fakes.testnet')?.[0]?.status).toBe('stale');
    expect(r.observations.get('usdc.fakes.testnet')?.[0]?.status).toBe('low_confidence');
  });
  it('401 (rejected key) is not retried and never leaks the key', async () => {
    const f = fakeFetch([
      ['/v2/price_feeds', pythFeeds],
      ['/v2/updates/price/latest', () => new Response('unauthorized', { status: 401 })],
    ]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'secret-key-xyz',
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(REFERENCE_ASSETS, NOW);
    // One request per feed, none retried.
    const feeds = REFERENCE_ASSETS.filter((a) => a.pyth).length;
    expect(f.calls.filter((c) => c.url.includes('/latest'))).toHaveLength(feeds);
    expect(r.status.health).toBe('unavailable');
    expect(r.status.detail).toContain('unauthorized');
    expect(JSON.stringify([...r.observations.values()])).not.toContain('secret-key-xyz');
  });

  it('a feed the key is not entitled to (403) fails alone; entitled feeds are still used', async () => {
    const nearFeed = NEAR.pyth?.feedId ?? '';
    const f = fakeFetch([
      ['/v2/price_feeds', pythFeeds],
      [`ids[]=${nearFeed}`, () => new Response('Not entitled: feed', { status: 403 })],
      ['/v2/updates/price/latest', () => pythLatest()],
    ]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'secret-key-xyz',
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(REFERENCE_ASSETS, NOW);
    expect(r.status.health).toBe('degraded');
    const near = r.observations.get(NEAR.testnetToken)?.[0];
    expect(near?.status).toBe('unavailable');
    expect(near?.reason).toContain('not entitled');
    expect(r.observations.get(USDT.testnetToken)?.[0]?.status).toBe('valid');
    expect(
      JSON.stringify([...r.observations.values()], (_k: string, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).not.toContain('secret-key-xyz');
  });
});

describe('DefiLlamaSource', () => {
  const llama = (routes: Array<[string, () => Response]>) => {
    const f = fakeFetch(routes);
    return {
      f,
      src: new DefiLlamaSource({
        baseUrl: 'https://llama.test',
        http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
      }),
    };
  };
  it('reads every key; low DefiLlama confidence, wrong decimals and missing keys are refused', async () => {
    const { src } = llama([
      [
        '/prices/current/',
        () => llamaCoins({ 'near:wrap.near': { decimals: 18 }, 'coingecko:usd-coin': null }),
      ],
    ]);
    const r = await src.observe(REFERENCE_ASSETS, NOW);
    const near = r.observations.get('wrap.testnet') ?? [];
    expect(near.map((o) => o.status)).toEqual(['valid', 'mapping_mismatch']);
    expect(r.observations.get('usdt.fakes.testnet')?.map((o) => o.status)).toEqual([
      'valid',
      'low_confidence',
    ]);
    expect(r.observations.get('usdc.fakes.testnet')?.[0]?.status).toBe('not_found');
    expect(r.status.health).toBe('degraded');
  });
  it('zero, negative and stale prices are refused', async () => {
    const { src } = llama([
      [
        '/prices/current/',
        () =>
          llamaCoins({
            'coingecko:near': { price: 0 },
            'near:wrap.near': { timestamp: nowS - 3600 },
            'coingecko:tether': { price: -1 },
          }),
      ],
    ]);
    const r = await src.observe(REFERENCE_ASSETS, NOW);
    expect(r.observations.get('wrap.testnet')?.map((o) => o.status)).toEqual(['invalid', 'stale']);
    expect(r.observations.get('usdt.fakes.testnet')?.[0]?.status).toBe('invalid');
  });
  it('HTTP 429: bounded retries honouring Retry-After, then unavailable (no endless retry)', async () => {
    const waits: number[] = [];
    const f = fakeFetch([
      [
        '/prices/current/',
        () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      ],
    ]);
    const src = new DefiLlamaSource({
      baseUrl: 'https://llama.test',
      http: new HttpJsonClient({
        fetchImpl: f.impl,
        maxRetries: 2,
        sleep: async (ms) => void waits.push(ms),
        random: () => 0,
      }),
    });
    const r = await src.observe(REFERENCE_ASSETS, NOW);
    expect(f.calls).toHaveLength(3);
    expect(waits).toEqual([2000, 2000]);
    expect(r.status.health).toBe('unavailable');
    expect(r.status.detail).toContain('rate_limit');
    expect([...r.observations.values()].flat().every((o) => o.priceUsd === null)).toBe(true);
  });
  it('timeout and network failure are classified', async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const http = new HttpJsonClient({ fetchImpl: hang, timeoutMs: 10, maxRetries: 0, ...noSleep });
    await expect(http.getJson('https://x.test')).rejects.toMatchObject({ kind: 'timeout' });
    const down = new HttpJsonClient({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      maxRetries: 0,
      ...noSleep,
    });
    const e = await down.getJson('https://x.test').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MarketHttpError);
    expect(e instanceof MarketHttpError && e.kind).toBe('unavailable');
  });
  it('24h range is computed from hourly points and skipped when history is short', async () => {
    const prices = Array.from({ length: 25 }, (_, i) => ({
      timestamp: nowS - 3600 * (24 - i),
      price: i === 3 ? 3.8 : i === 9 ? 4.18 : 4,
    }));
    const { src } = llama([
      [
        '/chart/',
        () =>
          json({
            coins: {
              'coingecko:near': { prices },
              'coingecko:tether': { prices: prices.slice(0, 3) },
            },
          }),
      ],
    ]);
    const r = await src.range24hBps(['coingecko:near', 'coingecko:tether']);
    expect(r.get('coingecko:near')).toBe(1000); // (4.18 - 3.8) / 3.8
    expect(r.has('coingecko:tether')).toBe(false);
  });
});

describe('ReferenceMarketData -> oracle and orchestrator market context', () => {
  const build = (
    routes: Array<[string, () => Response]>,
    opts: { pythKey?: string; decimals?: Record<string, number> } = {},
  ) => {
    const f = fakeFetch(routes);
    const http = new HttpJsonClient({ fetchImpl: f.impl, ...noSleep });
    const llama = new DefiLlamaSource({ baseUrl: 'https://llama.test', http });
    const recorded: MarketReport[] = [];
    let t = NOW.getTime();
    const market = new ReferenceMarketData({
      assets: REFERENCE_ASSETS,
      sources: [
        new PythSource({ baseUrl: 'https://hermes.test', apiKey: opts.pythKey, http }),
        llama,
      ],
      history: llama,
      testnetDecimals: async (token) =>
        opts.decimals?.[token] ??
        REFERENCE_ASSETS.find((a) => a.testnetToken === token)?.testnetDecimals ??
        null,
      sink: { record: async (r) => void recorded.push(r) },
      now: () => new Date(t),
      ids: () => `report-${recorded.length + 1}`,
    });
    return { market, f, recorded, advance: (ms: number) => (t += ms) };
  };

  it('Pyth + DefiLlama: all three priced, corroborated, persisted once per fetch (cached within the TTL)', async () => {
    const { market, recorded, f } = build(
      [
        ['/v2/price_feeds', pythFeeds],
        ['/v2/updates/price/latest', () => pythLatest()],
        ['/prices/current/', () => llamaCoins()],
        ['/chart/', () => json({ coins: {} })],
      ],
      { pythKey: 'k-12345678' },
    );
    const oracle = new ReferencePriceOracle(market);
    const { prices, asOf } = await oracle.getPrices([
      'wrap.testnet',
      'usdt.fakes.testnet',
      'usdc.fakes.testnet',
      'other.testnet',
    ] as TokenId[]);
    expect([...prices.keys()].sort()).toEqual([
      'usdc.fakes.testnet',
      'usdt.fakes.testnet',
      'wrap.testnet',
    ]);
    expect(prices.get('wrap.testnet' as TokenId)).toEqual({ multiplier: 398n, decimals: 26 }); // Pyth, priority
    expect(asOf.getTime()).toBe(NOW.getTime() - 2000);
    const ctx = await new ReferenceMarketProvider(market).get();
    expect(ctx?.referencePrices.get('wrap.testnet' as TokenId)).toEqual({
      multiplier: 399n,
      decimals: 26,
    }); // DefiLlama cross-check
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.assets.every((a) => a.status === 'corroborated')).toBe(true);
    expect(f.calls.filter((c) => c.url.includes('/prices/current/'))).toHaveLength(1);
  });

  it('no Pyth key: DefiLlama fallback, single_source; a dispute removes only that asset', async () => {
    const { market } = build([
      ['/prices/current/', () => llamaCoins({ 'near:wrap.near': { price: 4.5 } })],
      ['/chart/', () => json({ coins: {} })],
    ]);
    const report = await market.report();
    const by = (t: string) => report.assets.find((a) => a.testnetToken === t);
    expect(by('wrap.testnet')?.status).toBe('price_disputed');
    expect(by('usdt.fakes.testnet')?.status).toBe('single_source');
    expect(report.sources.find((s) => s.source === 'pyth')?.health).toBe('unavailable');
    const { prices } = await new ReferencePriceOracle(market).getPrices([
      'wrap.testnet',
      'usdt.fakes.testnet',
    ] as TokenId[]);
    expect(prices.has('wrap.testnet' as TokenId)).toBe(false);
    expect(prices.has('usdt.fakes.testnet' as TokenId)).toBe(true);
  });

  it('every source down: no prices at all (never zero), market context null', async () => {
    const { market } = build([['/', () => new Response('down', { status: 500 })]], {
      pythKey: 'k-12345678',
    });
    const { prices } = await new ReferencePriceOracle(market).getPrices([
      'wrap.testnet',
    ] as TokenId[]);
    expect(prices.size).toBe(0);
    expect(await new ReferenceMarketProvider(market).get()).toBeNull();
  });

  it('a testnet token whose live decimals differ from the mapping is unpriced', async () => {
    const { market } = build(
      [
        ['/prices/current/', () => llamaCoins()],
        ['/chart/', () => json({ coins: {} })],
      ],
      { decimals: { 'usdt.fakes.testnet': 18 } },
    );
    const report = await market.report();
    expect(report.assets.find((a) => a.testnetToken === 'usdt.fakes.testnet')?.status).toBe(
      'unpriced',
    );
  });

  it('the report is refreshed after the TTL, not reused forever', async () => {
    const { market, recorded, advance } = build([
      ['/prices/current/', () => llamaCoins()],
      ['/chart/', () => json({ coins: {} })],
    ]);
    await market.report();
    await market.report();
    advance(31_000);
    await market.report();
    expect(recorded).toHaveLength(2);
  });
});
