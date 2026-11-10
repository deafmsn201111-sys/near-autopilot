import { describe, expect, it } from 'vitest';
import type { TokenId } from '@near-autopilot/core';
import { ReferenceMarketProvider, ReferencePriceOracle } from '../src/market-data/adapters';
import { MAINNET_ASSETS, type ReferenceAsset } from '../src/market-data/assets';
import {
  decimalFromJsonNumber,
  deviationBps,
  formatDecimal,
  parseDecimal,
  toUnitPrice,
} from '../src/market-data/decimal';
import { HttpJsonClient, MarketHttpError } from '../src/market-data/http';
import { ExchangeSource, fetchLastTrade } from '../src/market-data/exchanges';
import {
  MAINNET_PRICE_LABEL,
  type MarketReport,
  type PriceObservation,
  type SourceName,
} from '../src/market-data/model';
import { convertQuotes, ReferenceMarketData, resolveAsset } from '../src/market-data/service';
import { DefiLlamaSource, PythSource } from '../src/market-data/sources';

const NOW = new Date('2026-11-04T12:00:00Z');
const nowS = NOW.getTime() / 1000;
const asset = (token: string): ReferenceAsset => {
  const a = MAINNET_ASSETS.find((x) => x.token === token);
  if (!a) throw new Error(token);
  return a;
};
const NEAR = asset('wrap.near');
const USDT = asset('usdt.tether-token.near');

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
    MAINNET_ASSETS.flatMap((a) =>
      a.pyth
        ? [{ id: a.pyth.feedId, attributes: { symbol: a.pyth.symbol, quote_currency: 'USD' } }]
        : [],
    ),
  );
const pythLatest = (
  over: Partial<Record<string, { price: string; conf?: string; t?: number }>> = {},
) =>
  json({
    parsed: MAINNET_ASSETS.flatMap((a) => {
      if (!a.pyth) return [];
      const o = over[a.token] ?? { price: a === NEAR ? '398000000' : '99990000' };
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
    'near:usdt.tether-token.near': {
      price: 0.999,
      symbol: 'USDt',
      timestamp: nowS - 10,
      confidence: 0.7,
      decimals: 6,
    },
    'coingecko:usd-coin': { price: 0.9998, symbol: 'USDC', timestamp: nowS - 10, confidence: 0.99 },
    'near:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
      price: 0.9994,
      symbol: 'USDC',
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
  source: SourceName,
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
    expect(r.label).toBe(MAINNET_PRICE_LABEL);
  });
  it('fallback (no quorum, stablecoins): Pyth unavailable -> DefiLlama alone, flagged single_source', () => {
    const r = resolveAsset(USDT, [obs('pyth', '0', 'unavailable'), obs('defillama', '0.999')], 6);
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
  it('token decimals differing from the mapping: unpriced even with valid prices', () => {
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
    const r = await pyth.observe(MAINNET_ASSETS, NOW);
    expect(r.status.health).toBe('unavailable');
    expect(f.calls).toHaveLength(0);
    expect(r.observations.get('wrap.near')?.[0]?.status).toBe('unavailable');
  });
  it('HTTP 403 (a plan without this feed) is NOT_ENTITLED, not an outage, and is not retried', async () => {
    const f = fakeFetch([['/v2/price_feeds', () => new Response('forbidden', { status: 403 })]]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'k-12345678',
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(MAINNET_ASSETS, NOW);
    expect(r.observations.get('wrap.near')?.[0]).toMatchObject({ status: 'not_entitled' });
    expect(f.calls).toHaveLength(1);
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
    const r = await pyth.observe(MAINNET_ASSETS, NOW);
    const near = r.observations.get('wrap.near')?.[0];
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
              id: asset('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1').pyth!
                .feedId,
              attributes: { symbol: 'Crypto.USDC/USD' },
            },
          ]),
      ],
      [
        '/v2/updates/price/latest',
        () =>
          pythLatest({
            'usdt.tether-token.near': { price: '99990000', t: nowS - 600 },
            '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
              price: '100000000',
              conf: '50000000',
            },
          }),
      ],
    ]);
    const pyth = new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'k-12345678',
      http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }),
    });
    const r = await pyth.observe(MAINNET_ASSETS, NOW);
    expect(r.observations.get('wrap.near')?.[0]?.status).toBe('mapping_mismatch');
    expect(r.observations.get('usdt.tether-token.near')?.[0]?.status).toBe('stale');
    expect(
      r.observations.get('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')?.[0]
        ?.status,
    ).toBe('low_confidence');
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
    const r = await pyth.observe(MAINNET_ASSETS, NOW);
    // One request per feed, none retried.
    const feeds = MAINNET_ASSETS.filter((a) => a.pyth).length;
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
    const r = await pyth.observe(MAINNET_ASSETS, NOW);
    expect(r.status.health).toBe('degraded');
    const near = r.observations.get(NEAR.token)?.[0];
    expect(near?.status).toBe('not_entitled'); // 403: not on this plan (reported apart from outages)
    expect(near?.reason).toContain('not entitled');
    expect(r.observations.get(USDT.token)?.[0]?.status).toBe('valid');
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
    const r = await src.observe(MAINNET_ASSETS, NOW);
    const near = r.observations.get('wrap.near') ?? [];
    expect(near.map((o) => o.status)).toEqual(['valid', 'mapping_mismatch']);
    expect(r.observations.get('usdt.tether-token.near')?.map((o) => o.status)).toEqual([
      'valid',
      'low_confidence',
    ]);
    expect(
      r.observations.get('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')?.[0]
        ?.status,
    ).toBe('not_found');
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
    const r = await src.observe(MAINNET_ASSETS, NOW);
    expect(r.observations.get('wrap.near')?.map((o) => o.status)).toEqual(['invalid', 'stale']);
    expect(r.observations.get('usdt.tether-token.near')?.[0]?.status).toBe('invalid');
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
    const r = await src.observe(MAINNET_ASSETS, NOW);
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
      assets: MAINNET_ASSETS,
      sources: [
        new PythSource({ baseUrl: 'https://hermes.test', apiKey: opts.pythKey, http }),
        llama,
      ],
      history: llama,
      tokenDecimals: async (token) =>
        opts.decimals?.[token] ?? MAINNET_ASSETS.find((a) => a.token === token)?.decimals ?? null,
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
      'wrap.near',
      'usdt.tether-token.near',
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      'other.near',
    ] as TokenId[]);
    expect([...prices.keys()].sort()).toEqual([
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      'usdt.tether-token.near',
      'wrap.near',
    ]);
    expect(prices.get('wrap.near' as TokenId)).toEqual({ multiplier: 398n, decimals: 26 }); // Pyth, priority
    expect(asOf.getTime()).toBe(NOW.getTime() - 2000);
    const ctx = await new ReferenceMarketProvider(market).get();
    expect(ctx?.referencePrices.get('wrap.near' as TokenId)).toEqual({
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
    const by = (t: string) => report.assets.find((a) => a.token === t);
    // NEAR has a quorum: DefiLlama alone (whose two keys even disagree) is one provider, never enough.
    expect(by('wrap.near')?.status).toBe('unpriced');
    expect(by('usdt.tether-token.near')?.status).toBe('single_source');
    expect(report.sources.find((s) => s.source === 'pyth')?.health).toBe('unavailable');
    const { prices } = await new ReferencePriceOracle(market).getPrices([
      'wrap.near',
      'usdt.tether-token.near',
    ] as TokenId[]);
    expect(prices.has('wrap.near' as TokenId)).toBe(false);
    expect(prices.has('usdt.tether-token.near' as TokenId)).toBe(true);
  });

  it('end to end: Pyth for USDT, NEAR from the exchange quorum with Binance converted through USDT/USD', async () => {
    const f = fakeFetch([
      ['/v2/price_feeds', pythFeeds],
      // NEAR feed refused (as on the live key), stablecoins entitled.
      ['/v2/updates/price/latest?ids[]=c415', () => json({ error: 'not entitled' }, 403)],
      ['/v2/updates/price/latest', () => pythLatest()],
      ['/prices/current/', () => llamaCoins({ 'coingecko:near': { timestamp: nowS - 449 } })],
      ['/chart/', () => json({ coins: {} })],
      [
        '/products/NEAR-USD/ticker',
        () => json({ price: '3.7065', time: new Date(NOW.getTime() - 3_000).toISOString() }),
      ],
      [
        '/0/public/Trades',
        () =>
          json({ error: [], result: { NEARUSD: [['3.7082', '1', nowS - 5, 's', 'l', '', 1]] } }),
      ],
      ['/api/v3/trades', () => json([{ price: '3.7110', time: NOW.getTime() - 2_000 }])],
    ]);
    const http = new HttpJsonClient({ fetchImpl: f.impl, ...noSleep });
    const llama = new DefiLlamaSource({
      baseUrl: 'https://llama.test',
      http,
      freshness: { maxAgeMs: 180_000, maxFutureSkewMs: 5_000 },
    });
    const market = new ReferenceMarketData({
      assets: MAINNET_ASSETS,
      sources: [
        new PythSource({ baseUrl: 'https://hermes.test', apiKey: 'k-12345678', http }),
        llama,
        new ExchangeSource({ name: 'coinbase', baseUrl: 'https://cb.test', http }),
        new ExchangeSource({ name: 'kraken', baseUrl: 'https://kr.test', http }),
        new ExchangeSource({ name: 'binance', baseUrl: 'https://bn.test', http }),
      ],
      tokenDecimals: async (t) => MAINNET_ASSETS.find((a) => a.token === t)?.decimals ?? null,
      now: () => NOW,
      ids: () => 'r1',
    });
    const report = await market.report();
    const near = report.assets.find((a) => a.token === 'wrap.near');
    expect(near?.status).toBe('corroborated');
    // coinbase 3.7065, kraken 3.7082, binance 3.711 x 0.9999 (Pyth USDT) = 3.7106289. DefiLlama's coingecko key is
    // stale, so its vote is near:wrap.near (4.00): an outlier, excluded and named.
    expect(near?.chosen?.source).toBe('kraken');
    expect(near?.reason).toContain('outliers excluded: defillama');
    const binance = near?.observations.find((o) => o.source === 'binance');
    expect(binance?.assetId).toBe('binance:NEARUSDT×USDT/USD(pyth)');
    expect(formatDecimal(binance!.priceUsd!)).toBe('3.7106289');
    expect(report.sources.map((s) => s.source)).toEqual([
      'pyth',
      'defillama',
      'coinbase',
      'kraken',
      'binance',
    ]);
  });

  it('every source down: no prices at all (never zero), market context null', async () => {
    const { market } = build([['/', () => new Response('down', { status: 500 })]], {
      pythKey: 'k-12345678',
    });
    const { prices } = await new ReferencePriceOracle(market).getPrices(['wrap.near'] as TokenId[]);
    expect(prices.size).toBe(0);
    expect(await new ReferenceMarketProvider(market).get()).toBeNull();
  });

  it('a token whose live decimals differ from the mapping is unpriced', async () => {
    const { market } = build(
      [
        ['/prices/current/', () => llamaCoins()],
        ['/chart/', () => json({ coins: {} })],
      ],
      { decimals: { 'usdt.tether-token.near': 18 } },
    );
    const report = await market.report();
    expect(report.assets.find((a) => a.token === 'usdt.tether-token.near')?.status).toBe(
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

describe('NEAR/USD quorum (2 providers within 150 bps of the median)', () => {
  it('one valid provider is NOT enough for NEAR: unpriced, no single-source fallback', () => {
    const r = resolveAsset(NEAR, [obs('pyth', '0', 'unavailable'), obs('defillama', '3.99')], 24);
    expect(r.status).toBe('unpriced');
    expect(r.priceUsd).toBeNull();
    expect(r.reason).toContain('quorum not met: 1 of 2');
  });
  it('three exchanges agree, DefiLlama stale: corroborated at the median observation', () => {
    const r = resolveAsset(
      NEAR,
      [
        obs('defillama', '3.80', 'stale'),
        obs('coinbase', '3.7065'),
        obs('kraken', '3.7082'),
        obs('binance', '3.7051'),
      ],
      24,
    );
    expect(r.status).toBe('corroborated');
    expect(r.chosen?.source).toBe('coinbase'); // median of 3.7051 / 3.7065 / 3.7082
    expect(formatDecimal(r.priceUsd!)).toBe('3.7065');
    expect(Number(r.spreadBps)).toBeLessThanOrEqual(150);
    expect(r.reason).toBeNull();
  });
  it('one outlier is excluded and named; the rest still form the quorum', () => {
    const r = resolveAsset(
      NEAR,
      [
        obs('defillama', '3.90'),
        obs('coinbase', '3.70'),
        obs('kraken', '3.71'),
        obs('binance', '3.705'),
      ],
      24,
    );
    expect(r.status).toBe('corroborated');
    expect(r.chosen?.source).toBe('binance'); // lower middle of 3.70 / 3.705 / 3.71 / 3.90
    expect(r.reason).toContain('outliers excluded: defillama');
  });
  it('two providers 200 bps apart (inside the old 200 bps limit) no longer agree: price_disputed', () => {
    const r = resolveAsset(NEAR, [obs('coinbase', '3.70'), obs('kraken', '3.774')], 24);
    expect(r.status).toBe('price_disputed');
    expect(r.priceUsd).toBeNull();
  });
  it('a USDT quote is never compared unconverted', () => {
    const usdtQuoted: PriceObservation = { ...obs('binance', '3.70'), quoteCurrency: 'USDT' };
    const r = resolveAsset(NEAR, [obs('coinbase', '3.70'), usdtQuoted], 24);
    expect(r.status).toBe('unpriced');
  });
});

describe('convertQuotes (Binance NEAR/USDT -> USD)', () => {
  const usdtQuote: PriceObservation = {
    ...obs('binance', '3.70'),
    assetId: 'binance:NEARUSDT',
    quoteCurrency: 'USDT',
    publishedAt: new Date(NOW.getTime() - 1_000),
  };
  const usdt = (status: 'corroborated' | 'single_source') =>
    ({
      ...resolveAsset(USDT, [obs('pyth', '0.9988'), obs('defillama', '0.9989')], 6),
      status,
      chosen: { ...obs('pyth', '0.9988'), publishedAt: new Date(NOW.getTime() - 30_000) },
    }) as const;
  it('multiplies by the corroborated USDT/USD price and keeps the older timestamp', () => {
    const [c] = convertQuotes([usdtQuote], usdt('corroborated'), NOW);
    expect(c?.quoteCurrency).toBe('USD');
    expect(formatDecimal(c!.priceUsd!)).toBe('3.69556');
    expect(c?.ageMs).toBe(30_000);
    expect(c?.assetId).toBe('binance:NEARUSDT×USDT/USD(pyth)');
    expect(c?.status).toBe('valid');
  });
  it('without a corroborated USDT price the quote is unavailable (USDT is never assumed to be 1.00)', () => {
    for (const u of [usdt('single_source'), null]) {
      const [c] = convertQuotes([usdtQuote], u, NOW);
      expect(c?.status).toBe('unavailable');
      expect(c?.priceUsd).toBeNull();
    }
  });
});

describe('exchange sources (last trade, public, no key)', () => {
  const http = (routes: Array<[string, () => Response]>) => {
    const f = fakeFetch(routes);
    return { f, http: new HttpJsonClient({ fetchImpl: f.impl, ...noSleep }) };
  };
  it('parses Coinbase ticker, Kraken trades (latest row) and Binance trades exactly', async () => {
    const { http: h } = http([
      [
        '/products/NEAR-USD/ticker',
        () => json({ price: '3.7065', time: '2026-11-04T11:59:58.395Z' }),
      ],
      [
        '/0/public/Trades',
        () =>
          json({
            error: [],
            result: {
              NEARUSD: [
                ['3.70820', '67.4', nowS - 9.5, 's', 'l', '', 1],
                ['3.70810', '67.4', nowS - 4.25, 's', 'l', '', 2],
              ],
              last: '1',
            },
          }),
      ],
      ['/api/v3/trades', () => json([{ price: '3.71100000', time: NOW.getTime() - 2_000 }])],
    ]);
    const cb = await fetchLastTrade(h, 'https://cb.test', {
      source: 'coinbase',
      symbol: 'NEAR-USD',
      quote: 'USD',
    });
    expect(formatDecimal(cb.price!)).toBe('3.7065');
    const kr = await fetchLastTrade(h, 'https://kr.test', {
      source: 'kraken',
      symbol: 'NEARUSD',
      quote: 'USD',
    });
    expect(formatDecimal(kr.price!)).toBe('3.7081');
    expect(kr.at?.getTime()).toBe(NOW.getTime() - 4_250);
    const bn = await fetchLastTrade(h, 'https://bn.test', {
      source: 'binance',
      symbol: 'NEARUSDT',
      quote: 'USDT',
    });
    expect(formatDecimal(bn.price!)).toBe('3.711');
  });
  it('a trade older than 180 s is stale; an error response makes the market unavailable', async () => {
    const { http: h } = http([
      [
        '/products/NEAR-USD/ticker',
        () => json({ price: '3.70', time: new Date(NOW.getTime() - 181_000).toISOString() }),
      ],
      ['/0/public/Trades', () => json({ error: ['EQuery:Unknown asset pair'] })],
    ]);
    const cb = await new ExchangeSource({
      name: 'coinbase',
      baseUrl: 'https://cb.test',
      http: h,
    }).observe([NEAR], NOW);
    expect(cb.observations.get(NEAR.token)?.[0]?.status).toBe('stale');
    expect(cb.status.health).toBe('degraded');
    const kr = await new ExchangeSource({
      name: 'kraken',
      baseUrl: 'https://kr.test',
      http: h,
    }).observe([NEAR], NOW);
    expect(kr.observations.get(NEAR.token)?.[0]?.status).toBe('unavailable');
    expect(kr.status.health).toBe('unavailable');
  });
  it('assets without a market on the exchange get no observation and no request', async () => {
    const { http: h, f } = http([]);
    const r = await new ExchangeSource({
      name: 'binance',
      baseUrl: 'https://bn.test',
      http: h,
    }).observe([USDT], NOW);
    expect(r.observations.size).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});
