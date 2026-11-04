import { u128StringSchema, type AccountId, type ContractViewer } from '@near-autopilot/core';
import { z } from 'zod';
import { compareDecimal, deviationBps, type Decimal } from '../market-data/decimal';
import { add, dec, div, fromRaw, mul } from '../yield/math';
import type {
  CollectorFilter,
  DiscoveredPool,
  PoolCategory,
  PoolClassification,
  PriceQuality,
  ReasonCode,
  TokenPrice,
} from './model';

/* ------------------------------ reading (views only, bounded pages) ------------------------------ */

const v1PoolSchema = z
  .object({
    pool_kind: z.string(),
    token_account_ids: z.array(z.string()),
    amounts: z.array(u128StringSchema),
    total_fee: z.number().int().min(0).max(10_000),
  })
  .passthrough();

const dclPoolSchema = z
  .object({
    pool_id: z.string(),
    token_x: z.string(),
    token_y: z.string(),
    fee: z.number().int().nonnegative(),
    state: z.string(),
    total_x: u128StringSchema.optional(),
    total_y: u128StringSchema.optional(),
  })
  .passthrough();

const V1_PAGE = 250;
const DCL_PAGE = 200;
/** Hard stop: a listing that does not end within this many pages is an error, never silently truncated. */
const MAX_PAGES = 400;

const asText = (v: unknown): string | null =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' ? String(v) : null;

/** Every Rhea v1 pool, page by page (`get_number_of_pools`, then `get_pools {from_index, limit}`). */
export async function scanV1Pools(
  viewer: ContractViewer,
  contract: AccountId,
): Promise<DiscoveredPool[]> {
  const count = z
    .number()
    .int()
    .nonnegative()
    .parse(await viewer.view(contract, 'get_number_of_pools', {}));
  const out: DiscoveredPool[] = [];
  for (let from = 0, page = 0; from < count; from += V1_PAGE, page += 1) {
    if (page >= MAX_PAGES) throw new Error('v1 pool listing did not terminate');
    const list = z
      .array(v1PoolSchema)
      .parse(await viewer.view(contract, 'get_pools', { from_index: from, limit: V1_PAGE }));
    list.forEach((p, i) =>
      out.push({
        poolKey: `v1:${from + i}`,
        family: 'v1',
        contract,
        poolType: p.pool_kind,
        tokens: p.token_account_ids,
        reserves: p.amounts,
        feeBps: p.total_fee,
        volumesIn: null,
        state: 'Running',
        raw: { poolId: from + i },
      }),
    );
    if (list.length === 0) break;
  }
  return out;
}

/** Every DCL pool, page by page (`list_pools {from_index, limit}`; unpaged exceeds the view gas limit). */
export async function scanDclPools(
  viewer: ContractViewer,
  contract: AccountId,
): Promise<DiscoveredPool[]> {
  const out: DiscoveredPool[] = [];
  for (let from = 0, page = 0; ; from += DCL_PAGE, page += 1) {
    if (page >= MAX_PAGES) throw new Error('DCL pool listing did not terminate');
    const list = z
      .array(dclPoolSchema)
      .parse(await viewer.view(contract, 'list_pools', { from_index: from, limit: DCL_PAGE }));
    for (const p of list) out.push(dclPool(contract, p));
    if (list.length < DCL_PAGE) return out;
  }
}

function dclPool(contract: string, p: z.infer<typeof dclPoolSchema>): DiscoveredPool {
  const extra = p as Record<string, unknown>;
  return {
    poolKey: `dcl:${p.pool_id}`,
    family: 'dcl',
    contract,
    poolType: 'DCL',
    tokens: [p.token_x, p.token_y],
    reserves: [p.total_x ?? 0n, p.total_y ?? 0n],
    // DCL fee is in 1e-6 of the swap (2000 = 0.2 %) -> bps.
    feeBps: Math.round(p.fee / 100),
    volumesIn: null,
    state: p.state,
    raw: {
      poolId: p.pool_id,
      feePpm: p.fee,
      currentPoint: asText(extra.current_point),
      liquidity: asText(extra.liquidity),
      totalFeeXCharged: asText(extra.total_fee_x_charged),
      totalFeeYCharged: asText(extra.total_fee_y_charged),
      volumeXIn: asText(extra.volume_x_in),
      volumeYIn: asText(extra.volume_y_in),
    },
  };
}

/** Re-read one tracked v1 pool with its cumulative volumes (`get_pool`, `get_pool_volumes`). */
export async function readV1Pool(
  viewer: ContractViewer,
  contract: AccountId,
  poolId: number,
): Promise<DiscoveredPool> {
  const p = v1PoolSchema.parse(await viewer.view(contract, 'get_pool', { pool_id: poolId }));
  const volumes = z
    .array(z.object({ input: u128StringSchema }).passthrough())
    .parse(await viewer.view(contract, 'get_pool_volumes', { pool_id: poolId }));
  return {
    poolKey: `v1:${poolId}`,
    family: 'v1',
    contract,
    poolType: p.pool_kind,
    tokens: p.token_account_ids,
    reserves: p.amounts,
    feeBps: p.total_fee,
    volumesIn: volumes.length === p.token_account_ids.length ? volumes.map((v) => v.input) : null,
    state: 'Running',
    raw: { poolId },
  };
}

export async function readDclPool(
  viewer: ContractViewer,
  contract: AccountId,
  poolId: string,
): Promise<DiscoveredPool | null> {
  const p = dclPoolSchema
    .nullable()
    .parse(await viewer.view(contract, 'get_pool', { pool_id: poolId }));
  return p ? dclPool(contract, p) : null;
}

/* ------------------------------ classification (pure) ------------------------------ */

export interface ClassifyInput {
  readonly pool: DiscoveredPool;
  readonly decimals: ReadonlyMap<string, number | null>;
  readonly prices: ReadonlyMap<string, TokenPrice>;
  readonly filter: CollectorFilter;
  /** Seconds of fee history already stored for this pool, and the volume over it (USD), if known. */
  readonly historySeconds: number;
  readonly windowVolumeUsd: Decimal | null;
}

const worst = (a: PriceQuality, b: PriceQuality): PriceQuality =>
  a === 'UNPRICED' || b === 'UNPRICED'
    ? 'UNPRICED'
    : a === 'LOW_CONFIDENCE' || b === 'LOW_CONFIDENCE'
      ? 'LOW_CONFIDENCE'
      : 'OK';

/**
 * Pool value and category. Precedence: DATA_INVALID > LOW_LIQUIDITY > UNSUPPORTED > LP_SIMULATION_ELIGIBLE >
 * ANALYTICS_ELIGIBLE > LIQUID > DISCOVERED. LOW_CONFIDENCE prices may only place a pool in LIQUID / LOW_LIQUIDITY
 * (discovery); analytics and LP simulation need every token priced OK.
 */
export function classifyPool(input: ClassifyInput): PoolClassification {
  const { pool, filter } = input;
  const reasons: ReasonCode[] = [];
  const supported =
    pool.family === 'v1' && pool.poolType === 'SIMPLE_POOL' && pool.tokens.length === 2;
  const modelStatus = supported ? 'SUPPORTED' : 'UNSUPPORTED_POOL_MODEL';
  const invalid = (code: string, detail: string): PoolClassification => ({
    category: 'DATA_INVALID',
    modelStatus,
    tvlUsd: null,
    priceQuality: 'UNPRICED',
    tvlMethod: null,
    reasons: [...reasons, { code, detail }],
    tracked: false,
  });
  if (pool.tokens.length < 2 || pool.reserves.length !== pool.tokens.length)
    return invalid('DATA_INVALID', 'tokens and reserves do not match');
  if (pool.state.toLowerCase() !== 'running')
    return invalid('POOL_INACTIVE', `pool state is ${pool.state}`);
  // An empty pool is correct data, just no liquidity: LOW_LIQUIDITY, not DATA_INVALID.
  if (pool.reserves.some((r) => r <= 0n))
    return {
      category: 'LOW_LIQUIDITY',
      modelStatus,
      tvlUsd: null,
      priceQuality: 'UNPRICED',
      tvlMethod: null,
      reasons: [{ code: 'EMPTY_POOL', detail: 'a reserve is zero' }],
      tracked: false,
    };
  // Decimals are needed (and read on-chain) only for priced tokens: an unpriced token cannot be valued anyway.
  if (pool.tokens.some((t) => input.prices.has(t) && (input.decimals.get(t) ?? null) === null))
    return invalid('DECIMALS_UNKNOWN', 'priced token with unreadable decimals (ft_metadata)');

  // Value: all tokens priced, or (two-token constant product only) twice the priced side.
  const values = pool.tokens.map((t, i) => {
    const p = input.prices.get(t);
    const d = input.decimals.get(t) ?? null;
    return p && d !== null
      ? { v: mul(fromRaw(pool.reserves[i] ?? 0n, d), p.usd), q: p.quality as PriceQuality }
      : null;
  });
  let tvlUsd: Decimal | null = null;
  let priceQuality: PriceQuality = 'UNPRICED';
  let tvlMethod: PoolClassification['tvlMethod'] = null;
  if (values.every((v) => v)) {
    tvlUsd = values.reduce<Decimal>((s, v) => add(s, v?.v ?? dec(0n)), dec(0n));
    priceQuality = values.reduce<PriceQuality>((q, v) => worst(q, v?.q ?? 'UNPRICED'), 'OK');
    tvlMethod = 'all_tokens';
  } else if (supported) {
    const side = values.find((v) => v);
    if (side) {
      tvlUsd = mul(side.v, dec(2n));
      priceQuality = worst(side.q, 'LOW_CONFIDENCE'); // one side only: never better than LOW_CONFIDENCE
      tvlMethod = 'priced_side_x2';
    }
  }
  if (!tvlUsd) {
    return {
      category: 'DISCOVERED',
      modelStatus,
      tvlUsd: null,
      priceQuality,
      tvlMethod,
      reasons: [{ code: 'UNPRICED', detail: 'no usable price for the pool tokens: value unknown' }],
      tracked: false,
    };
  }
  if (priceQuality === 'LOW_CONFIDENCE')
    reasons.push({
      code: 'LOW_CONFIDENCE',
      detail: 'valued with low-confidence prices: discovery only',
    });
  if (compareDecimal(tvlUsd, dec(BigInt(filter.minTvlUsd))) < 0)
    return {
      category: 'LOW_LIQUIDITY',
      modelStatus,
      tvlUsd,
      priceQuality,
      tvlMethod,
      reasons: [
        ...reasons,
        { code: 'LOW_LIQUIDITY', detail: `value below ${filter.minTvlUsd} USD` },
      ],
      tracked: false,
    };
  // Liquid from here on: tracked every cycle so history accumulates.
  if (!supported)
    return {
      category: 'UNSUPPORTED',
      modelStatus,
      tvlUsd,
      priceQuality,
      tvlMethod,
      reasons: [
        ...reasons,
        {
          code: 'UNSUPPORTED_POOL_MODEL',
          detail: `${pool.poolType}: no fee/IL model is implemented (only two-token SIMPLE_POOL)`,
        },
      ],
      tracked: true,
    };
  let category: PoolCategory = 'LIQUID';
  if (priceQuality === 'OK') {
    // Pool price must agree with the reference prices, or its quotes and value are not meaningful.
    const [a, b] = pool.tokens;
    const pa = a ? input.prices.get(a) : undefined;
    const pb = b ? input.prices.get(b) : undefined;
    const ra = fromRaw(pool.reserves[0] ?? 0n, input.decimals.get(a ?? '') ?? 0);
    const rb = fromRaw(pool.reserves[1] ?? 0n, input.decimals.get(b ?? '') ?? 0);
    const implied = pa && pb ? div(mul(rb, pb.usd), ra) : null;
    const gap = implied && pa && implied.mantissa > 0n ? deviationBps(implied, pa.usd) : null;
    if (gap === null || gap > BigInt(filter.maxPriceDeviationBps)) {
      reasons.push({
        code: 'PRICE_DEVIATION',
        detail: `pool price deviates ${gap ?? '?'} bps from the reference (limit ${filter.maxPriceDeviationBps})`,
      });
    } else if (input.historySeconds < filter.minHistorySeconds) {
      reasons.push({
        code: 'INSUFFICIENT_HISTORY',
        detail: `${input.historySeconds} s of fee history (needs ${filter.minHistorySeconds} s)`,
      });
    } else {
      category = 'ANALYTICS_ELIGIBLE';
      if (
        input.windowVolumeUsd &&
        compareDecimal(input.windowVolumeUsd, dec(BigInt(filter.minWindowVolumeUsd))) >= 0
      )
        category = 'LP_SIMULATION_ELIGIBLE';
      else
        reasons.push({
          code: 'LOW_VOLUME',
          detail: `traded volume over the history is below ${filter.minWindowVolumeUsd} USD`,
        });
    }
  }
  return { category, modelStatus, tvlUsd, priceQuality, tvlMethod, reasons, tracked: true };
}
