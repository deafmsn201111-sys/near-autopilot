import { describe, expect, it } from 'vitest';
import { accountIdSchema, RpcError, type Logger } from '@near-autopilot/core';
import { StaticPoolRegistry } from '@near-autopilot/rhea-adapter';
import { MAINNET_ASSETS } from '../src/market-data/assets';
import { buildAnalyticsServer } from '../src/analytics/server';
import { ShadowCollector, type CollectorDeps } from '../src/collector/collector';
import type { CollectorStore } from '../src/collector/store';
import type { EvidenceStore } from '../src/evidence/store';
import { probeRoutes } from '../src/gateway/probe';
import { OneClickClient } from '../src/gateway/one-click';
import { OneClickVenue, RheaVenue, type VenueRequest } from '../src/gateway/venues';
import { ExchangeSource } from '../src/market-data/exchanges';
import { HttpJsonClient, MarketHttpError } from '../src/market-data/http';
import { DefiLlamaSource, PythSource } from '../src/market-data/sources';
import { failureKind, publicFailure, publicText } from '../src/public-text';

const UPSTREAM =
  'boom https://internal-rpc.example:3030/x <html><body>bad</body></html>\n    at Foo.bar (/app/x.js:1:2)';
const LEAKS = ['internal-rpc', '<html', 'Foo.bar', 'boom', '://'];
const clean = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const leak of LEAKS) expect(s).not.toContain(leak);
};

const recorder = () => {
  const lines: string[] = [];
  const log = (m: string, f?: Record<string, unknown>) => lines.push(`${m} ${JSON.stringify(f)}`);
  const logger: Logger = { debug: log, info: log, warn: log, error: log };
  return { logger, logged: () => lines.join('\n') };
};

const providerBody = () =>
  new Response(JSON.stringify({ message: UPSTREAM.slice(0, 120) }), { status: 400 });
const http = () =>
  new HttpJsonClient({
    fetchImpl: async () => providerBody(),
    sleep: async () => {},
    random: () => 0,
  });

const NOW = new Date('2026-11-04T12:00:00Z');
const WNEAR = accountIdSchema.parse('wrap.near');
const USDC = accountIdSchema.parse('usdc.near');
const request: VenueRequest = {
  tokenIn: WNEAR,
  tokenOut: USDC,
  amountIn: 10n ** 24n,
  account: 'alice.near',
  slippageBps: 50,
  gasPriceYocto: 100_000_000n,
  now: () => NOW,
};

describe('failureKind', () => {
  it('names the error kind and HTTP status only, else unknown error', () => {
    expect(failureKind(new RpcError(UPSTREAM, true, { kind: 'timeout' }))).toBe('timeout');
    expect(failureKind(new MarketHttpError('http_error', `HTTP 400: ${UPSTREAM}`, false))).toBe(
      'http_error (HTTP 400)',
    );
    expect(failureKind(new MarketHttpError('invalid_response', UPSTREAM, false))).toBe(
      'invalid_response',
    );
    expect(failureKind(new Error(UPSTREAM))).toBe('unknown error');
  });
});

describe('publicText / publicFailure (rows stored before the fix)', () => {
  it('rewrites raw text after the known failure markers and keeps summaries', () => {
    expect(publicText(`quote failed: ${UPSTREAM.split('\n')[0]}`)).toBe(
      'quote failed: unknown error',
    );
    expect(publicText('quote failed: timeout')).toBe('quote failed: timeout');
    expect(publicText('$100: rhea; $1000: failed (HTTP 500 from https://x.example)')).toBe(
      '$100: rhea; $1000: failed (unknown error)',
    );
    expect(publicText('http_error: HTTP 400: bad key for https://x')).toBe('http_error');
    expect(publicText('pays 31 bps below the oracle (limit 30 bps)')).toBe(
      'pays 31 bps below the oracle (limit 30 bps)',
    );
    expect(publicText('3 feed(s) not valid')).toBe('3 feed(s) not valid');
    expect(publicText(null)).toBeNull();
  });
  it('anything with a URL, HTML, a stack line or too long becomes a fixed phrase', () => {
    expect(publicText(UPSTREAM)).toBe('failed');
    expect(publicText('see <b>here</b>')).toBe('failed');
    expect(publicText('x'.repeat(501))).toBe('failed');
  });
  it('a failure field keeps only the fixed phrases', () => {
    expect(publicFailure('failed: rate_limit')).toBe('failed: rate_limit');
    expect(publicFailure('cycle failed: unknown error')).toBe('cycle failed: unknown error');
    expect(publicFailure('HTTP 503 Service Unavailable')).toBe('failed: unknown error');
  });
});

describe('stored reasons hold fixed phrases (write side)', () => {
  it('venues: quote failed: <kind>, the full error goes to the log', async () => {
    const r = recorder();
    const rhea = new RheaVenue(
      {
        view: async () => {
          throw new RpcError(UPSTREAM, true, { kind: 'timeout' });
        },
      },
      {
        contractId: accountIdSchema.parse('v2.ref-finance.near'),
        pools: new StaticPoolRegistry([{ poolId: 1, tokenA: WNEAR, tokenB: USDC }]),
      },
      r.logger,
    );
    const q1 = await rhea.quote(request);
    expect(q1.ok ? null : q1.reason).toBe('quote failed: timeout');
    const oneClick = new OneClickVenue(
      new OneClickClient({ http: http(), baseUrl: 'https://1click.test' }),
      r.logger,
    );
    const q2 = await oneClick.quote(request);
    expect(q2.ok ? null : q2.reason).toBe('quote failed: http_error (HTTP 400)');
    clean([q1, q2]);
    expect(r.logged()).toContain('internal-rpc');
  });

  it('price observations: kind and HTTP status, no provider message', async () => {
    const llama = await new DefiLlamaSource({
      baseUrl: 'https://llama.test',
      http: http(),
    }).observe(MAINNET_ASSETS, NOW);
    const pyth = await new PythSource({
      baseUrl: 'https://hermes.test',
      apiKey: 'k',
      http: http(),
    }).observe(MAINNET_ASSETS, NOW);
    const exchange = await new ExchangeSource({
      name: 'coinbase',
      baseUrl: 'https://cb.test',
      http: http(),
    }).observe(MAINNET_ASSETS, NOW);
    for (const s of [llama, pyth, exchange]) {
      const reasons = [...s.observations.values()].flat().map((o) => o.reason);
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons)
        expect(reason).toMatch(/^(feed metadata: )?http_error \(HTTP 400\)$/);
      clean(s.status);
    }
  });

  it('collector: a failed source and a failed cycle store fixed phrases', async () => {
    const run = async (rpc: CollectorDeps['rpc']) => {
      const finished: unknown[] = [];
      const r = recorder();
      const store = {
        registryScanState: async () => null,
        startCycle: async () => true,
        finishCycle: async (_id: string, row: unknown) => {
          finished.push(row);
        },
      };
      const collector = new ShadowCollector({
        rpc,
        market: {
          report: async () => {
            throw new Error(UPSTREAM);
          },
        },
        store,
        logger: r.logger,
        now: () => NOW,
        ids: () => 'c-1',
        portfolios: [],
      } as unknown as CollectorDeps);
      const summary = await collector.runCycle('scheduled');
      clean([summary, finished]);
      return { summary, logged: r.logged() };
    };
    const cycle = await run({
      call: async () => {
        throw new Error(UPSTREAM);
      },
    });
    expect(cycle.summary.error).toBe('cycle failed: unknown error');
    expect(cycle.logged).toContain('internal-rpc');
    const source = await run({
      call: async () => ({ header: { height: 1, timestamp_nanosec: '1000000000' } }),
    });
    expect(source.summary.sources.find((s) => s.source === 'prices.curated')?.detail).toBe(
      'failed: unknown error',
    );
    expect(source.logged).toContain('internal-rpc');
  });

  it('route probe: a failed size is $<usd>: failed (<kind>)', async () => {
    const r = recorder();
    const res = await probeRoutes({
      prices: {
        getPrices: async () => ({
          prices: new Map([[WNEAR, { multiplier: 4n, decimals: 0 }]]),
          asOf: NOW,
        }),
      },
      repo: {
        insertExecutionRoute: async () => {
          throw new Error(UPSTREAM);
        },
      },
      venues: [],
      gasPrice: async () => 1n,
      clock: { now: () => NOW },
      ids: () => 'r-1',
      tokenIn: WNEAR,
      tokenOut: USDC,
      sizesUsd: [100],
      logger: r.logger,
    } as never);
    expect(res.detail).toBe('$100: failed (unknown error)');
    expect(r.logged()).toContain('internal-rpc');
  });
});

describe('served reasons go through the sanitiser (rows already in the DB)', () => {
  const TOKEN = 'public-text-token-public-text-token-123456';
  const auth = { authorization: `Bearer ${TOKEN}` };
  const cycle = {
    id: 'c-1',
    status: 'partial',
    trigger: 'scheduled',
    startedAt: NOW,
    finishedAt: NOW,
    durationMs: 1,
    records: 1,
    registryScan: false,
    error: UPSTREAM,
    sources: [
      { source: 'prices.curated', health: 'unavailable', detail: UPSTREAM },
      {
        source: 'routes.probe',
        health: 'degraded',
        detail: `$100: rhea; $1000: failed (${UPSTREAM})`,
      },
    ],
  };
  const obs = {
    asset: 'wrap.near',
    source: 'pyth',
    status: 'unavailable',
    priceUsd: null,
    quoteCurrency: 'USD',
    reason: `http_error: HTTP 400: ${UPSTREAM}`,
  };
  const store = {
    recentCycles: async () => [cycle],
    latestSnapshot: async () => ({ id: 's-1', blockHeight: 1, takenAt: NOW, summary: {} }),
    pools: async () => [],
    markets: async () => [],
    analysesForSnapshot: async () => [],
    pricesForSnapshot: async () => [obs],
    priceHistory: async () => [obs],
    db: {
      execute: async () => {
        throw new Error('no db');
      },
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
      }),
    },
  } as unknown as CollectorStore;
  const evidence = {
    routes: async () => [
      {
        origin: 'probe',
        reason: `no eligible venue: rhea: quote failed: ${UPSTREAM}`,
        quotes: {
          gasPriceYocto: '1',
          scored: [
            {
              quote: { ok: false, reason: `quote failed: ${UPSTREAM}` },
              excluded: `quote failed: ${UPSTREAM}`,
            },
          ],
        },
      },
    ],
  } as unknown as EvidenceStore;
  const app = buildAnalyticsServer({ apiToken: TOKEN, store, evidence, intervalSeconds: 900 });

  it.each([
    '/v1/analytics/overview',
    '/v1/analytics/collector',
    '/v1/analytics/system',
    '/v1/analytics/activity',
    '/v1/analytics/routes',
    '/v1/analytics/prices',
    '/v1/analytics/prices/wrap.near',
  ])('%s', async (url) => {
    const res = await app.inject({ url, headers: auth });
    expect(res.statusCode).toBe(200);
    clean(res.json());
  });

  it('keeps the useful part of a summary', async () => {
    const res = await app.inject({ url: '/v1/analytics/overview', headers: auth });
    const { sources } = res.json<{ collector: { sources: { detail: string }[] } }>().collector;
    expect(sources.map((s) => s.detail)).toEqual([
      'failed: unknown error',
      '$100: rhea; $1000: failed (unknown error)',
    ]);
  });
});
