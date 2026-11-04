import type { DclPool } from '@near-autopilot/rhea-dcl-adapter';
import type { RheaPoolInfo, RheaPoolVolume } from '@near-autopilot/rhea-adapter';
import { compareDecimal, deviationBps, formatDecimal, type Decimal } from '../market-data/decimal';
import type { YieldLimits } from './burrow';
import { add, dec, div, fromRaw, mul } from './math';
import type { BlockRef, PoolObservation, YieldEstimate, YieldNetwork, YieldReason } from './model';

const SECONDS_PER_YEAR = 31_536_000n;

export interface PoolContext {
  readonly network?: YieldNetwork;
  readonly contract: string;
  readonly block: BlockRef;
  readonly now: Date;
  readonly decimals: ReadonlyMap<string, number | null>;
  readonly priceUsd: (token: string) => Decimal | null;
  readonly allowedTokens: ReadonlySet<string>;
  readonly limits: YieldLimits;
  /** Largest accepted gap between the pool's implied price and the reference price (policy.maxOracleDeviationBps). */
  readonly maxPriceDeviationBps: number;
}

export interface RheaV1Input extends PoolContext {
  readonly pool: RheaPoolInfo;
  readonly volumes: readonly RheaPoolVolume[];
  readonly adminFeeBps: number;
  /** Pool ids the operator reviewed (config `rhea.pools`). Discovery never adds to it. */
  readonly allowlist: ReadonlySet<number>;
  readonly previous: PoolObservation | null;
  /** Shortest and longest accepted observation period for a fee APR. */
  readonly minPeriodSeconds: number;
  readonly maxPeriodSeconds: number;
}

const tokenChecks = (
  tokens: readonly string[],
  ctx: PoolContext,
  reasons: YieldReason[],
): { decimals: number[]; prices: Decimal[] } | null => {
  const decimals: number[] = [];
  const prices: Decimal[] = [];
  let ok = true;
  for (const t of tokens) {
    if (!ctx.allowedTokens.has(t))
      reasons.push({ code: 'UNVERIFIED_ASSET', detail: `${t} is not in policy.allowedTokens` });
    const d = ctx.decimals.get(t) ?? null;
    if (d === null) {
      reasons.push({ code: 'INVALID_YIELD_DATA', detail: `${t}: decimals unreadable` });
      ok = false;
    } else decimals.push(d);
    const p = ctx.priceUsd(t);
    if (!p) {
      reasons.push({ code: 'MISSING_PRICE', detail: `${t}: no usable price` });
      ok = false;
    } else prices.push(p);
  }
  return ok ? { decimals, prices } : null;
};

/** Value of a two-token reserve and the gap between the pool's implied price and the reference, in bps. */
function valuePool(
  reserves: readonly [bigint, bigint],
  decimals: readonly number[],
  prices: readonly Decimal[],
): { tvlUsd: Decimal; deviation: bigint } | null {
  const [ra, rb] = reserves;
  const [da = 0, db = 0] = decimals;
  const [pa, pb] = prices;
  if (!pa || !pb || ra <= 0n || rb <= 0n) return null;
  const a = fromRaw(ra, da);
  const b = fromRaw(rb, db);
  const va = mul(a, pa);
  const vb = mul(b, pb);
  // Implied USD price of token A = (B reserve value) / (A reserve amount); compare with A's reference price.
  const implied = div(vb, a);
  if (implied.mantissa <= 0n) return { tvlUsd: add(va, vb), deviation: 10n ** 9n };
  return { tvlUsd: add(va, vb), deviation: deviationBps(implied, pa) };
}

const liquidityChecks = (
  valued: { tvlUsd: Decimal; deviation: bigint } | null,
  ctx: PoolContext,
  reasons: YieldReason[],
): void => {
  if (!valued) return;
  if (valued.deviation > BigInt(ctx.maxPriceDeviationBps))
    reasons.push({
      code: 'INVALID_YIELD_DATA',
      detail: `pool price deviates ${valued.deviation > 10n ** 8n ? '>1,000,000' : valued.deviation.toString()} bps from the reference price (limit ${ctx.maxPriceDeviationBps}): quotes are not economically meaningful`,
    });
  if (compareDecimal(valued.tvlUsd, dec(BigInt(ctx.limits.minLiquidityUsd))) < 0)
    reasons.push({
      code: 'INSUFFICIENT_LIQUIDITY',
      detail: `pooled value is below ${ctx.limits.minLiquidityUsd} USD`,
    });
};

/**
 * One Rhea v1 SIMPLE_POOL -> an `lp_fee` estimate. The fee APR is HISTORICAL and needs two observations:
 *   volume_usd   = sum_i (input_i(now) - input_i(prev)) / 10^dec_i * price_i
 *   lp_fee_usd   = volume_usd * total_fee / 10^4 * (1 - admin_fee_bps / 10^4)
 *   apr          = lp_fee_usd / pooled_value_usd(now) * seconds_per_year / period_seconds
 * Without an earlier observation in [minPeriod, maxPeriod] the APR is not computed.
 */
export function rheaV1Estimate(input: RheaV1Input): YieldEstimate {
  const { pool, volumes, block } = input;
  const reasons: YieldReason[] = [];
  if (!input.allowlist.has(pool.poolId))
    reasons.push({
      code: 'UNVERIFIED_POOL',
      detail: 'pool is not in the operator allowlist (rhea.pools); observed only',
    });
  if (pool.kind !== 'SIMPLE_POOL' || pool.tokens.length !== 2)
    reasons.push({
      code: 'INVALID_YIELD_DATA',
      detail: `${pool.kind} with ${pool.tokens.length} tokens: only two-token SIMPLE_POOL is supported`,
    });
  if (volumes.length !== pool.tokens.length)
    reasons.push({ code: 'INVALID_YIELD_DATA', detail: 'volumes do not match pool tokens' });
  const tokens = pool.tokens.slice(0, 2);
  const priced = tokenChecks(tokens, input, reasons);
  const [ra = 0n, rb = 0n] = pool.reserves;
  if (ra <= 0n || rb <= 0n)
    reasons.push({ code: 'INSUFFICIENT_LIQUIDITY', detail: 'a reserve is zero' });
  const valued = priced ? valuePool([ra, rb], priced.decimals, priced.prices) : null;
  liquidityChecks(valued, input, reasons);

  let apr: Decimal | null = null;
  let volumeUsd: Decimal | null = null;
  let period: number | null = null;
  const prevInputs = Array.isArray(input.previous?.raw.volumesIn)
    ? (input.previous.raw.volumesIn as unknown[]).map((v) => (typeof v === 'string' ? v : ''))
    : null;
  // The start of the period must itself have been a sound observation: it may only have lacked a period of its own.
  const startFlaws = (input.previous?.reasonCodes ?? []).filter(
    (c) => c !== 'MISSING_YIELD_DATA' && c !== 'UNVERIFIED_POOL',
  );
  const breakdown: Record<string, unknown> = {};
  if (!input.previous || !prevInputs) {
    reasons.push({
      code: 'MISSING_YIELD_DATA',
      detail: `no earlier observation at least ${input.minPeriodSeconds} s old: a fee APR needs an observation period`,
    });
  } else if (input.previous.blockHeight >= block.height) {
    reasons.push({
      code: 'INVALID_YIELD_DATA',
      detail: `start observation (block ${input.previous.blockHeight}) is not before this one (block ${block.height})`,
    });
  } else if (startFlaws.length > 0) {
    reasons.push({
      code: 'INVALID_YIELD_DATA',
      detail: `start observation (block ${input.previous.blockHeight}) failed validation: ${[...new Set(startFlaws)].join(', ')}`,
    });
  } else {
    period = Math.floor((block.timestamp.getTime() - input.previous.observedAt.getTime()) / 1000);
    if (period > input.maxPeriodSeconds) {
      reasons.push({
        code: 'STALE_YIELD_DATA',
        detail: `earlier observation is ${period} s old (limit ${input.maxPeriodSeconds} s)`,
      });
    } else if (priced && valued && volumes.length === 2 && prevInputs.length === 2) {
      let total: Decimal = dec(0n);
      for (let i = 0; i < 2; i += 1) {
        const now = volumes[i]?.input ?? 0n;
        const prevText = prevInputs[i] ?? '';
        const before = /^\d+$/.test(prevText) ? BigInt(prevText) : -1n;
        if (before < 0n || now < before) {
          reasons.push({
            code: 'INVALID_YIELD_DATA',
            detail: 'cumulative volume went down or is unreadable between observations',
          });
          total = dec(-1n);
          break;
        }
        total = add(
          total,
          mul(fromRaw(now - before, priced.decimals[i] ?? 0), priced.prices[i] ?? dec(0n)),
        );
      }
      if (total.mantissa >= 0n && valued.tvlUsd.mantissa > 0n && period > 0) {
        volumeUsd = total;
        // Fees are charged on the INPUT of each swap, so input volumes count every swap exactly once.
        const lpShare = dec(BigInt(pool.totalFeeBps * (10_000 - input.adminFeeBps)), -8);
        const grossFees = mul(total, dec(BigInt(pool.totalFeeBps), -4));
        const feesUsd = mul(total, lpShare);
        apr = div(mul(feesUsd, dec(SECONDS_PER_YEAR)), mul(valued.tvlUsd, dec(BigInt(period))));
        // For comparison only: the same fees on the start and on the average pool value (start valued at today's
        // prices). The reported APR uses the END value.
        const prevReserves = Array.isArray(input.previous.raw.reserves)
          ? (input.previous.raw.reserves as unknown[]).map((v) =>
              typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : -1n,
            )
          : [];
        const [pa = -1n, pb = -1n] = prevReserves;
        const start =
          pa > 0n && pb > 0n ? valuePool([pa, pb], priced.decimals, priced.prices) : null;
        Object.assign(breakdown, {
          periodStart: input.previous.observedAt.toISOString(),
          periodEnd: block.timestamp.toISOString(),
          volumeInRaw: volumes.map((v, i) => (v.input - BigInt(prevInputs[i] ?? '0')).toString()),
          volumeUsd: formatDecimal(total),
          grossFeesUsd: formatDecimal(grossFees),
          lpFeesUsd: formatDecimal(feesUsd),
          endPooledUsd: formatDecimal(valued.tvlUsd),
          startPooledUsdAtCurrentPrices: start ? formatDecimal(start.tvlUsd) : null,
          aprOnAveragePooledUsd: start
            ? formatDecimal(
                div(
                  mul(feesUsd, dec(SECONDS_PER_YEAR * 2n)),
                  mul(add(valued.tvlUsd, start.tvlUsd), dec(BigInt(period))),
                ),
              )
            : null,
        });
        if (compareDecimal(apr, dec(BigInt(input.limits.maxAprBps), -4)) > 0)
          reasons.push({
            code: 'INVALID_YIELD_DATA',
            detail: `fee APR above the ${input.limits.maxAprBps / 100} % plausibility limit`,
          });
      }
    }
  }
  const age = (input.now.getTime() - block.timestamp.getTime()) / 1000;
  if (age > input.limits.maxAgeSeconds)
    reasons.push({ code: 'STALE_YIELD_DATA', detail: `block is ${Math.round(age)} s old` });

  return {
    source: 'rhea_v1',
    network: input.network ?? 'testnet',
    contract: input.contract,
    methods: ['get_pool', 'get_pool_volumes', 'metadata'],
    marketId: `pool:${pool.poolId}`,
    assetIds: pool.tokens,
    yieldType: 'lp_fee',
    apr,
    apy: null,
    calculationMethod: 'calculated',
    formula:
      'lp_fee_usd = Δvolume_in_usd × total_fee/1e4 × (1 − admin_fee_bps/1e4); apr = lp_fee_usd / pooled_usd × year / period (historical)',
    observationPeriodSeconds: period,
    utilization: null,
    liquidityUsd: valued?.tvlUsd ?? null,
    volumeUsd,
    priceStatus: priced ? 'fresh' : 'missing',
    block,
    sourceTimestamp: null,
    validationStatus: reasons.length === 0 ? 'valid' : 'rejected',
    reasons,
    raw: {
      poolId: pool.poolId,
      kind: pool.kind,
      tokens: pool.tokens,
      reserves: pool.reserves.map(String),
      totalFeeBps: pool.totalFeeBps,
      adminFeeBps: input.adminFeeBps,
      volumesIn: volumes.map((v) => v.input.toString()),
      volumesOut: volumes.map((v) => v.output.toString()),
      previousBlockHeight: input.previous?.blockHeight ?? null,
      ...breakdown,
    },
  };
}

/**
 * One DCL pool -> an `lp_fee` record WITHOUT an APR. A concentrated-liquidity fee rate depends on the liquidity in
 * range and fee growth inside it, which this stage does not compute; the pool's state is collected and validated so
 * the data exists, and the estimate is always rejected with MISSING_YIELD_DATA. No DCL pool is operator-reviewed.
 */
export function dclEstimate(input: PoolContext & { readonly pool: DclPool }): YieldEstimate {
  const { pool, block } = input;
  const reasons: YieldReason[] = [
    { code: 'UNVERIFIED_POOL', detail: 'no DCL pool is operator-reviewed; observed only' },
  ];
  if (pool.state.toLowerCase() !== 'running')
    reasons.push({ code: 'INVALID_YIELD_DATA', detail: `pool state is ${pool.state}` });
  const priced = tokenChecks([pool.token_x, pool.token_y], input, reasons);
  const tx = pool.total_x ?? 0n;
  const ty = pool.total_y ?? 0n;
  let liquidityUsd: Decimal | null = null;
  if (priced) {
    const [dx = 0, dy = 0] = priced.decimals;
    const [px, py] = priced.prices;
    if (px && py) liquidityUsd = add(mul(fromRaw(tx, dx), px), mul(fromRaw(ty, dy), py));
    if (liquidityUsd && compareDecimal(liquidityUsd, dec(BigInt(input.limits.minLiquidityUsd))) < 0)
      reasons.push({
        code: 'INSUFFICIENT_LIQUIDITY',
        detail: `pooled value is below ${input.limits.minLiquidityUsd} USD`,
      });
  }
  reasons.push({
    code: 'MISSING_YIELD_DATA',
    detail: 'DCL fee APR is not computed at this stage (needs in-range liquidity and fee growth)',
  });
  const extra = pool as Record<string, unknown>;
  const text = (k: string): string | null =>
    typeof extra[k] === 'string' || typeof extra[k] === 'bigint' ? String(extra[k]) : null;
  return {
    source: 'rhea_dcl',
    network: input.network ?? 'testnet',
    contract: input.contract,
    methods: ['get_pool'],
    marketId: pool.pool_id,
    assetIds: [pool.token_x, pool.token_y],
    yieldType: 'lp_fee',
    apr: null,
    apy: null,
    calculationMethod: 'calculated',
    formula: null,
    observationPeriodSeconds: null,
    utilization: null,
    liquidityUsd,
    volumeUsd: null,
    priceStatus: priced ? 'fresh' : 'missing',
    block,
    sourceTimestamp: null,
    validationStatus: 'rejected',
    reasons,
    raw: {
      feePpm: pool.fee,
      currentPoint: pool.current_point,
      state: pool.state,
      liquidity: pool.liquidity?.toString() ?? null,
      totalX: tx.toString(),
      totalY: ty.toString(),
      totalFeeXCharged: pool.total_fee_x_charged?.toString() ?? null,
      totalFeeYCharged: pool.total_fee_y_charged?.toString() ?? null,
      volumeXIn: text('volume_x_in'),
      volumeYIn: text('volume_y_in'),
    },
  };
}
