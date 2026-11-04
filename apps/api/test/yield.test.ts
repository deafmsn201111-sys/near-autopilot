import type { BurrowAsset } from '@near-autopilot/burrow-adapter';
import { accountId } from '@near-autopilot/core';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import type { RheaPoolInfo } from '@near-autopilot/rhea-adapter';
import { describe, expect, it } from 'vitest';
import { formatDecimal, parseDecimal, type Decimal } from '../src/market-data/decimal';
import { yieldContext } from '../src/market-data/adapters';
import { burrowEstimates, type YieldLimits } from '../src/yield/burrow';
import { div, dec, toWad } from '../src/yield/math';
import type { BlockRef, YieldEstimate } from '../src/yield/model';
import { dclEstimate, rheaV1Estimate } from '../src/yield/rhea';
import { YieldService, type YieldServiceOptions } from '../src/yield/service';

const NOW = new Date('2026-11-05T10:00:00Z');
const BLOCK: BlockRef = { height: 1_000, timestamp: new Date(NOW.getTime() - 2_000) };
const LIMITS: YieldLimits = {
  maxAprBps: 10_000,
  maxUtilizationBps: 9_500,
  minLiquidityUsd: 1_000,
  maxAgeSeconds: 300,
};
const WRAP = 'wrap.testnet';
const USDC = 'usdc.fakes.testnet';
const USDT = 'usdt.fakes.testnet';
const ALLOWED = new Set([WRAP, USDC, USDT]);
const PRICES: Record<string, string> = { [WRAP]: '4', [USDC]: '1', [USDT]: '1' };
const priceUsd = (t: string): Decimal | null => (PRICES[t] ? parseDecimal(PRICES[t]) : null);
const DECIMALS = new Map<string, number | null>([
  [WRAP, 24],
  [USDC, 6],
  [USDT, 6],
]);

const asset = (over: Omit<Partial<BurrowAsset>, 'tokenId'> & { tokenId: string }): BurrowAsset => ({
  extraDecimals: 0,
  volatilityRatioBps: 9_500,
  canDeposit: true,
  canWithdraw: true,
  canUseAsCollateral: true,
  canBorrow: true,
  suppliedInner: 0n,
  borrowedInner: 0n,
  reservedInner: 0n,
  supplyApr: '0',
  borrowApr: '0',
  lastUpdateTimestampNs: 1_793_000_000_000_000_000n,
  ...over,
  tokenId: accountId(over.tokenId),
});

// Shapes taken from the live testnet reading of 2026-11-04 (block 276239768).
const USDC_LIVE = asset({
  tokenId: USDC,
  extraDecimals: 12,
  suppliedInner: 467947437630330149660512n,
  borrowedInner: 445891911733811208719508n,
  reservedInner: 82476107748909662712953n,
  supplyApr: '0.104335039813366256446294778',
  borrowApr: '0.145994468617227838115968768',
});
const WRAP_LIVE = asset({
  tokenId: WRAP,
  suppliedInner: 797956930989491808390457145228836n,
  borrowedInner: 1062676043301754308843535407333635n,
  reservedInner: 264720365393889078925869747506669n,
  supplyApr: '2.497000482062869906959227371',
  borrowApr: '2.499976487228021259060060563',
});

const burrow = (assets: BurrowAsset[], over: Partial<Parameters<typeof burrowEstimates>[0]> = {}) =>
  burrowEstimates({
    contract: 'contract.1638481328.burrow.testnet',
    assets,
    block: BLOCK,
    now: NOW,
    decimals: DECIMALS,
    priceUsd,
    allowedTokens: ALLOWED,
    limits: LIMITS,
    ...over,
  });
const supplyOf = (es: YieldEstimate[], token: string) =>
  es.find((e) => e.marketId === token && e.yieldType === 'lending_supply');
const codes = (e: YieldEstimate | undefined) => e?.reasons.map((r) => r.code) ?? [];

describe('Burrow lending rates', () => {
  it('a healthy market yields a valid, source-reported APR (never an APY) and an informational borrow cost', () => {
    const es = burrow([USDC_LIVE]);
    const s = supplyOf(es, USDC);
    expect(s?.validationStatus).toBe('valid');
    expect(s?.apr && formatDecimal(s.apr)).toBe('0.104335039813366256446294778');
    expect(s?.apy).toBeNull();
    expect(s?.calculationMethod).toBe('source_reported');
    expect(s?.block.height).toBe(1_000);
    // utilisation = borrowed / (supplied + reserved) = 0.8100...
    expect(s?.utilization && formatDecimal(s.utilization).slice(0, 6)).toBe('0.8100');
    // withdrawable = (supplied + reserved - borrowed) / 10^12 raw = 104,531.63 USDC at $1
    expect(s?.liquidityUsd && formatDecimal(s.liquidityUsd).slice(0, 9)).toBe('104531.63');
    const b = es.find((e) => e.yieldType === 'lending_borrow');
    expect(b?.validationStatus).toBe('informational');
    expect(b?.apr && formatDecimal(b.apr)).toBe('0.145994468617227838115968768');
  });

  it('rejects a market pinned at 100 % utilisation with an implausible 250 % APR (the live wrap.testnet case)', () => {
    const s = supplyOf(burrow([WRAP_LIVE]), WRAP);
    expect(s?.validationStatus).toBe('rejected');
    expect(codes(s)).toContain('INVALID_YIELD_DATA'); // APR above 100 %
    expect(codes(s)).toContain('INSUFFICIENT_LIQUIDITY'); // utilisation >= 95 %
    expect(s?.apr).not.toBeNull(); // the observed rate is still recorded
  });

  it('keeps the rate but rejects it without a price, an allowed token, fresh data or a parsable rate', () => {
    expect(codes(supplyOf(burrow([USDC_LIVE], { priceUsd: () => null }), USDC))).toEqual([
      'MISSING_PRICE',
    ]);
    expect(codes(supplyOf(burrow([USDC_LIVE], { allowedTokens: new Set() }), USDC))).toEqual([
      'UNVERIFIED_ASSET',
    ]);
    const stale = { height: 1, timestamp: new Date(NOW.getTime() - 301_000) };
    expect(codes(supplyOf(burrow([USDC_LIVE], { block: stale }), USDC))).toEqual([
      'STALE_YIELD_DATA',
    ]);
    for (const bad of ['NaN', '-0.1', '1e999', 'abc']) {
      const s = supplyOf(burrow([{ ...USDC_LIVE, supplyApr: bad }]), USDC);
      expect(codes(s)).toContain('INVALID_YIELD_DATA');
      expect(s?.validationStatus).toBe('rejected');
    }
    expect(codes(supplyOf(burrow([{ ...USDC_LIVE, supplyApr: null }]), USDC))).toEqual([
      'MISSING_YIELD_DATA',
    ]);
  });

  it('rejects empty, over-borrowed, thin, closed and unreadable-decimals markets', () => {
    expect(codes(supplyOf(burrow([asset({ tokenId: USDT })]), USDT))).toContain(
      'INSUFFICIENT_LIQUIDITY',
    );
    const over = asset({ tokenId: USDT, suppliedInner: 10n, borrowedInner: 11n });
    expect(codes(supplyOf(burrow([over]), USDT))).toContain('INVALID_YIELD_DATA');
    const thin = asset({ tokenId: USDT, suppliedInner: 100_000_000n }); // 100 USDT
    expect(codes(supplyOf(burrow([thin]), USDT))).toEqual(['INSUFFICIENT_LIQUIDITY']);
    expect(codes(supplyOf(burrow([{ ...USDC_LIVE, canWithdraw: false }]), USDC))).toContain(
      'INVALID_YIELD_DATA',
    );
    const noDecimals = new Map(DECIMALS);
    noDecimals.set(USDC, null);
    expect(codes(supplyOf(burrow([USDC_LIVE], { decimals: noDecimals }), USDC))).toContain(
      'INVALID_YIELD_DATA',
    );
  });
});

const pool = (over: Partial<RheaPoolInfo> = {}): RheaPoolInfo => ({
  poolId: 7,
  kind: 'SIMPLE_POOL',
  tokens: [accountId(WRAP), accountId(USDC)],
  reserves: [1000n * 10n ** 24n, 4000n * 10n ** 6n],
  totalFeeBps: 30,
  sharesTotalSupply: 1n,
  ...over,
});
const v1 = (over: Partial<Parameters<typeof rheaV1Estimate>[0]> = {}) =>
  rheaV1Estimate({
    contract: 'ref-finance-101.testnet',
    block: BLOCK,
    now: NOW,
    decimals: DECIMALS,
    priceUsd,
    allowedTokens: ALLOWED,
    limits: LIMITS,
    maxPriceDeviationBps: 150,
    pool: pool(),
    volumes: [
      { input: 10n * 10n ** 24n, output: 0n },
      { input: 360n * 10n ** 6n, output: 0n },
    ],
    adminFeeBps: 2_000,
    allowlist: new Set([7]),
    previous: {
      observedAt: new Date(BLOCK.timestamp.getTime() - 86_400_000),
      blockHeight: 900,
      raw: { volumesIn: ['0', '0'] },
    },
    minPeriodSeconds: 3_600,
    maxPeriodSeconds: 604_800,
    ...over,
  });

describe('Rhea v1 LP fee APR', () => {
  it('computes a historical fee APR from two observations: 400 USD volume, 30 bps, 20 % admin fee, 8000 USD pool, 1 day', () => {
    const e = v1();
    expect(e.validationStatus).toBe('valid');
    expect(e.observationPeriodSeconds).toBe(86_400);
    expect(e.volumeUsd && formatDecimal(e.volumeUsd)).toBe('400');
    expect(e.liquidityUsd && formatDecimal(e.liquidityUsd)).toBe('8000');
    // 400 * 0.0030 * 0.8 = 0.96 USD/day; 0.96 * 365 / 8000 = 0.0438
    expect(e.apr && formatDecimal(e.apr)).toBe('0.0438');
    expect(e.apy).toBeNull();
    expect(e.calculationMethod).toBe('calculated');
  });

  it('never computes an APR without an observation period, and rejects stale or decreasing volumes', () => {
    const first = v1({ previous: null });
    expect(first.apr).toBeNull();
    expect(codes(first)).toEqual(['MISSING_YIELD_DATA']);
    const old = v1({
      previous: {
        observedAt: new Date(BLOCK.timestamp.getTime() - 700_000_000),
        blockHeight: 1,
        raw: { volumesIn: ['0', '0'] },
      },
    });
    expect(codes(old)).toContain('STALE_YIELD_DATA');
    expect(old.apr).toBeNull();
    const down = v1({
      previous: {
        observedAt: new Date(BLOCK.timestamp.getTime() - 86_400_000),
        blockHeight: 1,
        raw: { volumesIn: [(11n * 10n ** 24n).toString(), '0'] },
      },
    });
    expect(codes(down)).toContain('INVALID_YIELD_DATA');
    expect(down.apr).toBeNull();
  });

  it('a pool outside the allowlist is observed only (UNVERIFIED_POOL), never auto-added', () => {
    const allowlist = new Set<number>();
    const e = v1({ allowlist });
    expect(codes(e)).toEqual(['UNVERIFIED_POOL']);
    expect(e.validationStatus).toBe('rejected');
    expect(allowlist.size).toBe(0);
  });

  it('rejects economically meaningless pools: live pool #34 (0.82 wNEAR vs 3.8e16 USDT)', () => {
    const e = v1({
      pool: pool({
        poolId: 34,
        tokens: [accountId(WRAP), accountId(USDT)],
        reserves: [819156702302060887075743n, 37953844514821027459510n],
      }),
      allowlist: new Set(),
      previous: null,
    });
    expect(codes(e)).toEqual(
      expect.arrayContaining(['UNVERIFIED_POOL', 'INVALID_YIELD_DATA', 'MISSING_YIELD_DATA']),
    );
    expect(e.reasons.find((r) => r.code === 'INVALID_YIELD_DATA')?.detail).toContain('deviates');
  });

  it('rejects unknown tokens, missing prices, zero reserves and non-simple pools', () => {
    expect(codes(v1({ allowedTokens: new Set([WRAP]) }))).toContain('UNVERIFIED_ASSET');
    expect(codes(v1({ priceUsd: (t) => (t === WRAP ? priceUsd(t) : null) }))).toContain(
      'MISSING_PRICE',
    );
    expect(codes(v1({ pool: pool({ reserves: [0n, 1n] }) }))).toContain('INSUFFICIENT_LIQUIDITY');
    expect(codes(v1({ pool: pool({ kind: 'STABLE_SWAP' }) }))).toContain('INVALID_YIELD_DATA');
    expect(codes(v1({ pool: pool({ reserves: [10n ** 24n, 4n * 10n ** 6n] }) }))).toContain(
      'INSUFFICIENT_LIQUIDITY',
    );
  });
});

describe('Rhea DCL', () => {
  it('collects pool state but never reports a fee APR at this stage', () => {
    const e = dclEstimate({
      contract: 'dclv2.ref-dev.testnet',
      block: BLOCK,
      now: NOW,
      decimals: DECIMALS,
      priceUsd,
      allowedTokens: ALLOWED,
      limits: LIMITS,
      maxPriceDeviationBps: 150,
      pool: {
        pool_id: `${USDT}|${WRAP}|2000`,
        token_x: accountId(USDT),
        token_y: accountId(WRAP),
        fee: 2000,
        point_delta: 40,
        current_point: 193_627,
        state: 'Running',
        total_x: 1_571_297_856_824_340_558n,
        total_y: 132_522_726_074_018_445_873n,
      },
    });
    expect(e.apr).toBeNull();
    expect(e.validationStatus).toBe('rejected');
    expect(codes(e)).toEqual(expect.arrayContaining(['UNVERIFIED_POOL', 'MISSING_YIELD_DATA']));
  });
});

describe('exact yield math', () => {
  it('converts fractions to WAD without floats', () => {
    expect(toWad(parseDecimal('0.104335039813366256446294778') as Decimal)).toBe(
      104335039813366256n,
    );
    expect(formatDecimal(div(dec(1n), dec(3n)))).toBe('0.333333333333333333');
  });
});

/* ------------------------------ service over a fake testnet RPC ------------------------------ */

const enc = (v: unknown) => ({ result: [...Buffer.from(JSON.stringify(v), 'utf8')] });

function fakeRpc(opts: { failRhea?: boolean; failBlock?: boolean } = {}) {
  const queries: { account: string; method: string; blockId: unknown }[] = [];
  const rpc = {
    async call(method: string, params: unknown): Promise<unknown> {
      if (method === 'block') {
        if (opts.failBlock) throw new Error('block unavailable');
        return { header: { height: 500, timestamp_nanosec: `${BLOCK.timestamp.getTime()}000000` } };
      }
      const p = params as { account_id: string; method_name: string; block_id?: unknown };
      queries.push({ account: p.account_id, method: p.method_name, blockId: p.block_id });
      if (p.method_name === 'ft_metadata') {
        const d = DECIMALS.get(p.account_id);
        return enc({ spec: 'ft-1.0.0', name: p.account_id, symbol: 'X', decimals: d ?? 0 });
      }
      if (p.account_id === 'burrow.testnet' && p.method_name === 'get_assets_paged_detailed') {
        const args = JSON.parse(
          Buffer.from((params as { args_base64: string }).args_base64, 'base64').toString(),
        ) as { from_index: number };
        if (args.from_index > 0) return enc([]);
        return enc([
          {
            token_id: USDC,
            supplied: { shares: '1', balance: USDC_LIVE.suppliedInner.toString() },
            borrowed: { shares: '1', balance: USDC_LIVE.borrowedInner.toString() },
            reserved: USDC_LIVE.reservedInner.toString(),
            config: {
              reserve_ratio: 2500,
              target_utilization: 8000,
              volatility_ratio: 9500,
              extra_decimals: 12,
              can_deposit: true,
              can_withdraw: true,
              can_use_as_collateral: true,
              can_borrow: true,
            },
            supply_apr: USDC_LIVE.supplyApr,
            borrow_apr: USDC_LIVE.borrowApr,
            last_update_timestamp: '1793000000000000000',
          },
        ]);
      }
      if (p.account_id === 'ref.testnet') {
        if (opts.failRhea) throw new Error('rhea down');
        if (p.method_name === 'metadata')
          return enc({ version: '1.9.19', state: 'Running', admin_fee_bps: 2000 });
        if (p.method_name === 'get_pool')
          return enc({
            pool_kind: 'SIMPLE_POOL',
            token_account_ids: [WRAP, USDC],
            amounts: [(1000n * 10n ** 24n).toString(), (4000n * 10n ** 6n).toString()],
            total_fee: 30,
            shares_total_supply: '1',
          });
        if (p.method_name === 'get_pool_volumes')
          return enc([
            { input: '0', output: '0' },
            { input: '0', output: '0' },
          ]);
      }
      throw new Error(`unexpected ${p.account_id}#${p.method_name}`);
    },
  };
  return { rpc, queries };
}

const service = (rpc: YieldServiceOptions['rpc'], over: Partial<YieldServiceOptions> = {}) => {
  let n = 0;
  return new YieldService({
    rpc,
    burrowContract: accountId('burrow.testnet'),
    rheaContract: accountId('ref.testnet'),
    dclContract: null,
    rheaV1Pools: [7],
    dclPools: [],
    allowlist: new Set(),
    allowedTokens: ALLOWED,
    prices: async () => priceUsd,
    history: null,
    limits: LIMITS,
    maxPriceDeviationBps: 150,
    minPeriodSeconds: 3_600,
    maxPeriodSeconds: 604_800,
    now: () => NOW,
    ids: () => `r${(n += 1)}`,
    ...over,
  });
};

describe('YieldService', () => {
  it('reads every view at one pinned final block and reports each source', async () => {
    const { rpc, queries } = fakeRpc();
    const r = await service(rpc).report();
    expect(r.block?.height).toBe(500);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.blockId === 500)).toBe(true);
    expect(r.sources.map((s) => [s.source, s.health])).toEqual([
      ['burrow', 'ok'],
      ['rhea_v1', 'ok'],
      ['rhea_dcl', 'disabled'],
    ]);
    expect(supplyOf([...r.estimates], USDC)?.validationStatus).toBe('valid');
    const lp = r.estimates.find((e) => e.source === 'rhea_v1');
    expect(codes(lp)).toEqual(expect.arrayContaining(['UNVERIFIED_POOL', 'MISSING_YIELD_DATA']));
  });

  it('keeps valid Burrow data when Rhea fails, without substituting anything for Rhea', async () => {
    const r = await service(fakeRpc({ failRhea: true }).rpc).report();
    expect(r.sources.find((s) => s.source === 'rhea_v1')?.health).toBe('unavailable');
    expect(r.estimates.some((e) => e.source === 'rhea_v1')).toBe(false);
    expect(supplyOf([...r.estimates], USDC)?.validationStatus).toBe('valid');
  });

  it('without a readable block nothing is reported as data', async () => {
    const r = await service(fakeRpc({ failBlock: true }).rpc).report();
    expect(r.block).toBeNull();
    expect(r.estimates).toEqual([]);
    expect(r.sources.filter((s) => s.health === 'unavailable').map((s) => s.source)).toEqual([
      'burrow',
      'rhea_v1',
    ]);
  });

  it('reuses one report within the TTL and persists it; a failing sink does not drop the report', async () => {
    const { rpc } = fakeRpc();
    const recorded: string[] = [];
    let clock = NOW.getTime();
    const s = service(rpc, {
      now: () => new Date(clock),
      sink: {
        async record(rep) {
          recorded.push(rep.id);
          throw new Error('db down');
        },
      },
    });
    const a = await s.report();
    const b = await s.report();
    expect(b.id).toBe(a.id);
    clock += 31_000;
    const c = await s.report();
    expect(c.id).not.toBe(a.id);
    expect(recorded).toEqual([a.id, c.id]);
  });

  it('a rate-limited RPC (HTTP 429) is retried a bounded number of times, then the source is unavailable', async () => {
    let calls = 0;
    const rpc = new NearRpcClient({
      url: 'http://rpc.invalid',
      maxRetries: 2,
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      },
    });
    const r = await service(rpc).report();
    expect(calls).toBe(3); // 1 + 2 retries for the block, then stop
    expect(r.block).toBeNull();
    expect(r.estimates).toEqual([]);
  });
});

describe('yields in the orchestrator market context', () => {
  it('only valid Burrow supply rates become estimatedYieldWad; every other token carries its reason', async () => {
    const r = await service(fakeRpc().rpc).report();
    const ctx = yieldContext(r, [accountId(USDC), accountId(WRAP)]);
    expect(ctx.estimatedYieldWad.get(accountId(USDC))).toBe(104335039813366256n);
    expect(ctx.estimatedYieldWad.has(accountId(WRAP))).toBe(false);
    expect(ctx.yieldNotes.get(accountId(WRAP))).toContain('MISSING_YIELD_DATA');
    expect(ctx.lpNote).toContain('1 pool(s) observed, 0 usable');
    expect(ctx.asOf?.getTime()).toBe(BLOCK.timestamp.getTime());
  });
});

describe('yield audit trail', () => {
  it('stores the report, then records one yield.report audit event with sources, counts and rejection codes', async () => {
    const { AuditedYieldSink } = await import('../src/yield/audit');
    const order: string[] = [];
    const events: { type: string; payload: unknown }[] = [];
    const sink = new AuditedYieldSink(
      {
        async record() {
          order.push('store');
        },
        async previous() {
          return null;
        },
      },
      {
        async appendAudit(e) {
          order.push('audit');
          events.push({ type: e.type, payload: e.payload });
        },
      },
    );
    const r = await service(fakeRpc().rpc, { sink }).report();
    expect(order).toEqual(['store', 'audit']);
    expect(events[0]?.type).toBe('yield.report');
    const p = events[0]?.payload as {
      reportId: string;
      blockHeight: number;
      counts: { valid: number };
    };
    expect(p.reportId).toBe(r.id);
    expect(p.blockHeight).toBe(500);
    expect(p.counts.valid).toBe(1);
    expect(JSON.stringify(p)).toContain('UNVERIFIED_POOL');
  });
});
