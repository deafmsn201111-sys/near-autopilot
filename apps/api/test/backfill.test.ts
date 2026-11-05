import { describe, expect, it } from 'vitest';
import type { AccountId } from '@near-autopilot/core';
import {
  findBlockAt,
  historicalPrices,
  runBackfill,
  v1PoolId,
  type BackfillDeps,
} from '../src/collector/backfill';
import type { PoolObservationRow } from '../src/collector/store';
import { HttpJsonClient } from '../src/market-data/http';

const NEAR = 'wrap.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const HEAD = 10_000_000;
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const MS_PER_BLOCK = 1_100;
/** Pool 7 exists for the last 400,000 blocks (~5.1 days); cumulative USDC volume grows 1 USDC per block. */
const CREATED = HEAD - 400_000;

const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v), 'utf8')];
const blockTs = (h: number) => T0 - (HEAD - h) * MS_PER_BLOCK;

/** A fake ARCHIVAL rpc: every 7th height is a skipped block; views answer at the pinned height. */
function fakeRpc() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const p = params as Record<string, unknown>;
    calls.push({ method, params: p });
    if (method === 'block') {
      const h = typeof p.block_id === 'number' ? p.block_id : HEAD;
      if (h % 7 === 0 || h > HEAD) throw new Error('UNKNOWN_BLOCK');
      return { header: { height: h, timestamp_nanosec: `${BigInt(blockTs(h)) * 1_000_000n}` } };
    }
    if (method === 'query') {
      const h = p.block_id as number;
      const name = p.method_name as string;
      if (name === 'metadata') return { result: bytes({ admin_fee_bps: 2000 }) };
      if (h < CREATED) return { error: 'wasm execution failed: pool not found' };
      if (name === 'get_pool')
        return {
          result: bytes({
            pool_kind: 'SIMPLE_POOL',
            token_account_ids: [USDC, NEAR],
            amounts: ['1000000000000', '250000000000000000000000000000'], // $1M USDC / 250k NEAR
            total_fee: 30,
          }),
        };
      if (name === 'get_pool_volumes')
        return {
          result: bytes([
            { input: `${(h - CREATED) * 1_000_000}`, output: '0' },
            { input: '0', output: '0' },
          ]),
        };
    }
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

function fakeHttp(nearLlama: number, nearCoinbase: number | null) {
  const urls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const ts = Number(/historical\/(\d+)\//.exec(url)?.[1] ?? /start=([^&]+)/.exec(url)?.[1]);
    if (url.includes('/prices/historical/'))
      return json({
        coins: {
          'coingecko:near': { price: nearLlama, timestamp: ts - 60, confidence: 0.99 },
          'coingecko:usd-coin': { price: 1, timestamp: ts - 60, confidence: 0.99 },
        },
      });
    if (url.includes('/candles')) {
      const start = Date.parse(decodeURIComponent(/start=([^&]+)/.exec(url)?.[1] ?? '')) / 1000;
      return json(
        nearCoinbase === null ? [] : [[start + 600, 1, 1, nearCoinbase, nearCoinbase, 100]],
      );
    }
    return new Response('nf', { status: 404 });
  };
  return {
    urls,
    http: new HttpJsonClient({ fetchImpl: impl, sleep: async () => {}, random: () => 0.5 }),
  };
}

const URLS = { defillama: 'https://llama.test', coinbase: 'https://cb.test' };

describe('findBlockAt (archival block for a past time)', () => {
  it('finds a real block within 10 min of the target, stepping over skipped heights', async () => {
    const rpc = fakeRpc();
    const target = new Date(T0 - 30 * 86_400_000);
    const b = await findBlockAt(
      rpc,
      target,
      { height: HEAD, timestamp: new Date(T0) },
      10 * 60_000,
    );
    expect(Math.abs(b.timestamp.getTime() - target.getTime())).toBeLessThanOrEqual(10 * 60_000);
    expect(b.height % 7).not.toBe(0);
    expect(b.timestamp.getTime()).toBe(blockTs(b.height)); // the block's own time, not an estimate
  });
});

describe('historicalPrices (TVL of a past state)', () => {
  const at = new Date(T0 - 86_400_000);
  it('NEAR is OK only when a Coinbase candle agrees within 150 bps', async () => {
    const ok = await historicalPrices(fakeHttp(4.0, 4.02).http, URLS, [NEAR, USDC], at);
    expect(ok.get(NEAR)?.quality).toBe('OK');
    expect(ok.get(NEAR)?.sourceAssetId).toContain('coinbase:NEAR-USD');
    expect(ok.get(USDC)?.quality).toBe('OK');
    const off = await historicalPrices(fakeHttp(4.0, 4.1).http, URLS, [NEAR, USDC], at);
    expect(off.has(NEAR)).toBe(false); // 250 bps apart: no NEAR price at all
    const none = await historicalPrices(fakeHttp(4.0, null).http, URLS, [NEAR], at);
    expect(none.get(NEAR)?.quality).toBe('LOW_CONFIDENCE');
  });
});

describe('runBackfill', () => {
  const build = () => {
    const rpc = fakeRpc();
    const stored: PoolObservationRow[] = [];
    const existing: Date[] = [new Date(T0 - 2 * 86_400_000 + 3_600_000)]; // a point 1 h from the day-2 target
    const deps: BackfillDeps = {
      rpc,
      http: fakeHttp(4.0, 4.01).http,
      defillamaUrl: URLS.defillama,
      coinbaseUrl: URLS.coinbase,
      rheaContract: 'v2.ref-finance.near' as AccountId,
      store: {
        pointTimes: async () => existing,
        insertPoolObservations: async (rows) => void stored.push(...rows),
      },
      now: () => new Date(T0),
      log: () => {},
    };
    return { deps, stored, rpc };
  };
  const target = { poolKey: 'v1:7', poolId: 7, tokens: [USDC, NEAR], decimals: [6, 24] };

  it('stores one point per day at a real past block, valued with historical prices, marked as backfill', async () => {
    const { deps, stored, rpc } = build();
    const s = await runBackfill(deps, [target], { days: 3, stepHours: 24, skipWithinHours: 3 });
    expect(s).toMatchObject({ targets: 1, skipped: 1, inserted: 2, missing: 0, failed: 0 });
    for (const r of stored) {
      expect(r.id).toBe(`v1:7@${r.blockHeight}`);
      expect(r.blockTimestamp?.getTime()).toBe(blockTs(r.blockHeight));
      expect(r.volumesIn).toEqual([`${(r.blockHeight - CREATED) * 1_000_000}`, '0']);
      expect(r.adminFeeBps).toBe(2000);
      expect(r.priceQuality).toBe('OK');
      expect(Number(r.tvlUsd)).toBeCloseTo(2_000_000, 0); // $1M USDC + 250k NEAR x 4.00
      expect((r.raw as { backfill: { source: string } }).backfill.source).toBe('archival-rpc');
    }
    // Read-only: only block lookups and view calls, every view pinned to a block height.
    expect(new Set(rpc.calls.map((c) => c.method))).toEqual(new Set(['block', 'query']));
    for (const c of rpc.calls.filter((x) => x.method === 'query')) {
      expect(c.params.request_type).toBe('call_function');
      expect(typeof c.params.block_id).toBe('number');
    }
  });

  it('a pool that did not exist yet at the past block is counted missing, not invented', async () => {
    const { deps, stored } = build();
    const s = await runBackfill(deps, [target], { days: 60, stepHours: 24, skipWithinHours: 3 });
    // Days 1, 3, 4, 5 exist (day 2 already has a point); days 6..60 fall before the pool was created.
    expect(s).toMatchObject({ inserted: 4, skipped: 1, missing: 55 });
    expect(stored.every((r) => r.blockHeight >= CREATED)).toBe(true);
  });

  it('v1 pool ids only', () => {
    expect(v1PoolId('v1:4512')).toBe(4512);
    expect(v1PoolId('dcl:a|b|100')).toBeNull();
  });
});
