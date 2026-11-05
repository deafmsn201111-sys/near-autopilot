import { constantProductQuote } from '@near-autopilot/financial-engine';
import { z } from 'zod';

/**
 * THESIS ANALYSIS, pure and offline: raw RPC answers in, metrics out. No network, no clock, no randomness, so the same
 * raw files give the same numbers on every machine.
 *
 * Rhea pools are valued in NEAR through the pool's OWN price (wNEAR reserve / other reserve), so no external price
 * enters the yield figures; for a constant-product pool TVL = 2 x wNEAR reserve. External NEAR/USD is used only to
 * size the $500 / $5,000 entry and exit and to state TVL in USD.
 *
 *   nominal APR (24h)    gross fees of the last day / TVL x 365        what a pool list typically shows
 *   fee APR (realized)   LP share of fees over the window / mean TVL, annualised (simple)
 *   LP vs HODL           value of one LP share at the end / value of the tokens that share held at the start, valued
 *                        at the end price, minus 1: fees AND impermanent loss together, measured, not modelled
 *   net APR ($S)         LP vs HODL annualised, minus the round-trip cost of a $S position (two half-swaps through the
 *                        pool at the end reserves + gas upper bound) spread over the window
 *
 * Burrow: realized supply APR = growth of the supply share price (balance / shares) over the window, annualised;
 * nominal = the supply_apr the contract reports at the end block.
 */
const u = z.string().regex(/^\d+$/);
export const rheaLine = z.object({
  height: z.number().int(),
  pool: z.number().int(),
  get_pool: z
    .object({
      pool_kind: z.string(),
      token_account_ids: z.array(z.string()),
      amounts: z.array(u),
      total_fee: z.number().int(),
      shares_total_supply: u,
    })
    .passthrough()
    .nullable(),
  get_pool_volumes: z.array(z.object({ input: u, output: u })).nullable(),
  error: z.string().nullable(),
});
export const metaLine = z.object({
  height: z.number().int(),
  metadata: z.object({ admin_fee_bps: z.number().int() }).passthrough(),
});
export const gasLine = z.object({
  height: z.number().int(),
  gas_price: z.object({ gas_price: u }),
});
const share = z.object({ shares: u, balance: u });
export const burrowLine = z.object({
  height: z.number().int(),
  response_sha256: z.string(),
  assets: z.array(
    z
      .object({
        token_id: z.string(),
        supplied: share,
        borrowed: share,
        reserved: u,
        supply_apr: z.string(),
        borrow_apr: z.string(),
      })
      .passthrough(),
  ),
});
export const priceLine = z.object({
  height: z.number().int(),
  ts: z.number().int(),
  defillama: z.unknown(),
  coinbase: z.unknown(),
});
export const manifestSchema = z.object({
  end: z.string(),
  days: z.number().int(),
  blocks: z.array(
    z.object({
      height: z.number().int(),
      hash: z.string(),
      timestamp: z.string(),
      target: z.string(),
    }),
  ),
  universe: z.object({
    rule: z.string(),
    candidates: z.number().int(),
    pools: z.array(z.number().int()),
  }),
});

export type RheaLine = z.infer<typeof rheaLine>;
export type BurrowLine = z.infer<typeof burrowLine>;
export type PriceLine = z.infer<typeof priceLine>;
export type Manifest = z.infer<typeof manifestSchema>;

const WNEAR = 'wrap.near';
const DAY = 86_400_000;
const YOCTO = 1e24;
/** Same quorum rule as the live price service: two independent sources within 150 bps, else no price. */
const NEAR_AGREE_BPS = 150;

// ------------------------------------------------------------------------------------------------ NEAR/USD

export interface NearUsd {
  readonly height: number;
  readonly usd: number | null;
  readonly defillama: number | null;
  readonly coinbase: number | null;
  readonly note: string;
}

export function nearUsd(p: PriceLine): NearUsd {
  const llama = z
    .object({
      coins: z.object({
        'coingecko:near': z.object({ price: z.number(), timestamp: z.number() }).optional(),
      }),
    })
    .safeParse(p.defillama);
  const l = llama.success ? llama.data.coins['coingecko:near'] : undefined;
  const dl = l && Math.abs(l.timestamp - p.ts) <= 7_200 ? l.price : null;
  const rows = z
    .array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]))
    .safeParse(p.coinbase);
  let cb: number | null = null;
  if (rows.success && rows.data.length > 0) {
    const nearest = rows.data.reduce((a, b) =>
      Math.abs(b[0] - p.ts) < Math.abs(a[0] - p.ts) ? b : a,
    );
    cb = Math.abs(nearest[0] - p.ts) <= 600 ? nearest[4] : null;
  }
  if (dl === null || cb === null)
    return {
      height: p.height,
      usd: null,
      defillama: dl,
      coinbase: cb,
      note: 'one source missing: no price',
    };
  const mid = (dl + cb) / 2;
  const bps = (Math.abs(dl - cb) / mid) * 10_000;
  return bps > NEAR_AGREE_BPS
    ? {
        height: p.height,
        usd: null,
        defillama: dl,
        coinbase: cb,
        note: `sources ${bps.toFixed(0)} bps apart: no price`,
      }
    : { height: p.height, usd: mid, defillama: dl, coinbase: cb, note: 'ok' };
}

// ------------------------------------------------------------------------------------------------ Rhea

export interface PoolPoint {
  readonly height: number;
  readonly t: number;
  readonly rN: bigint;
  readonly rO: bigint;
  readonly shares: bigint;
  readonly volN: bigint;
  readonly volO: bigint;
  readonly feeBps: number;
  readonly adminBps: number;
}

export interface DailyPoint {
  readonly pool: number;
  readonly date: string;
  readonly height: number;
  readonly tvlNear: number;
  readonly priceNearPerOther: number;
  /** Gross fees of the day before this point / TVL, x 365. null for the first point. */
  readonly nominalApr24h: number | null;
  readonly shareValueNear: number;
}

export interface PoolMetrics {
  readonly pool: number;
  readonly other: string;
  readonly feeBps: number;
  readonly firstDate: string;
  readonly days: number;
  readonly tvlNearEnd: number;
  readonly tvlUsdEnd: number | null;
  readonly nominalApr24hEnd: number | null;
  readonly nominalApr24hMin: number | null;
  readonly nominalApr24hMedian: number | null;
  readonly nominalApr24hMax: number | null;
  readonly feeAprRealized: number;
  /** Impermanent loss implied by the price change over the window (fraction, <= 0). */
  readonly ilWindow: number;
  readonly lpVsHodlWindow: number;
  readonly lpVsHodlApr: number;
  readonly lpReturnInNearApr: number;
  readonly roundTripCostUsd500: number | null;
  readonly roundTripCostUsd5000: number | null;
  readonly netApr500: number | null;
  readonly netApr5000: number | null;
  /** Gap between what the list shows and what an LP kept: nominal 24h APR minus LP vs HODL APR. */
  readonly gap: number | null;
}

const toNear = (raw: bigint) => Number(raw) / YOCTO;

export function poolPoints(
  lines: readonly RheaLine[],
  admin: ReadonlyMap<number, number>,
  times: ReadonlyMap<number, number>,
): Map<number, PoolPoint[]> {
  const out = new Map<number, PoolPoint[]>();
  for (const l of lines) {
    const p = l.get_pool;
    const v = l.get_pool_volumes;
    const t = times.get(l.height);
    const a = admin.get(l.height);
    if (!p || !v || t === undefined || a === undefined || p.pool_kind !== 'SIMPLE_POOL') continue;
    const n = p.token_account_ids.indexOf(WNEAR);
    const o = 1 - n;
    if (n < 0 || p.token_account_ids.length !== 2) continue;
    const rN = BigInt(p.amounts[n] ?? '0');
    const rO = BigInt(p.amounts[o] ?? '0');
    const shares = BigInt(p.shares_total_supply);
    if (rN <= 0n || rO <= 0n || shares <= 0n) continue; // an empty pool has no price or share value
    const list = out.get(l.pool) ?? [];
    list.push({
      height: l.height,
      t,
      rN,
      rO,
      shares,
      volN: BigInt(v[n]?.input ?? '0'),
      volO: BigInt(v[o]?.input ?? '0'),
      feeBps: p.total_fee,
      adminBps: a,
    });
    out.set(l.pool, list);
  }
  for (const list of out.values()) list.sort((x, y) => x.height - y.height);
  return out;
}

/** Fees between two points, in NEAR: inputs times the fee, the other token valued at the later point's pool price. */
function feesNear(a: PoolPoint, b: PoolPoint, lpOnly: boolean): number {
  const share = lpOnly ? (b.feeBps * (10_000 - b.adminBps)) / 1e8 : b.feeBps / 1e4;
  const dN = b.volN - a.volN;
  const dO = b.volO - a.volO;
  if (dN < 0n || dO < 0n) return Number.NaN; // cumulative volumes never fall; if they do the data is wrong
  const price = toNear(b.rN) / Number(b.rO); // NEAR per raw unit of the other token
  return (toNear(dN) + Number(dO) * price) * share;
}

const median = (xs: readonly number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? null) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

export interface CostInputs {
  readonly nearUsd: number | null;
  readonly gasPriceYocto: bigint;
  /** Attached gas of the 4 transactions of a round trip (swap, add, remove, swap): an upper bound. */
  readonly roundTripGas: bigint;
}

/** NEAR lost by a round trip of `sizeNear` at the end reserves: swap half in, add; remove, swap back. No price move. */
function roundTripCostNear(end: PoolPoint, sizeNear: number, gasNear: number): number {
  const size = BigInt(Math.round(sizeNear * 1e6)) * 10n ** 18n;
  const half = size / 2n;
  const feePpm = end.feeBps * 100;
  const buy = constantProductQuote({
    reserveIn: end.rN,
    reserveOut: end.rO,
    amountIn: half,
    feePpm,
  });
  // Add the other half NEAR + the bought tokens, then remove the same share right away: the share is worth exactly
  // its part of the reserves after the buy, so the exit swaps the bought tokens back through the moved pool.
  const sell = constantProductQuote({
    reserveIn: buy.reserveOutAfter,
    reserveOut: buy.reserveInAfter,
    amountIn: buy.amountOut,
    feePpm,
  });
  const back = half + sell.amountOut;
  return toNear(size - back) + gasNear;
}

export function poolMetrics(
  pool: number,
  other: string,
  points: readonly PoolPoint[],
  costs: CostInputs,
): { metrics: PoolMetrics; daily: DailyPoint[] } | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 8) return null;
  const days = (last.t - first.t) / DAY;
  const tvl = (p: PoolPoint) => 2 * toNear(p.rN);
  const daily: DailyPoint[] = points.map((p, i) => {
    const prev = i > 0 ? points[i - 1] : undefined;
    const span = prev ? (p.t - prev.t) / DAY : 0;
    return {
      pool,
      date: new Date(p.t).toISOString().slice(0, 10),
      height: p.height,
      tvlNear: tvl(p),
      priceNearPerOther: toNear(p.rN) / Number(p.rO),
      nominalApr24h: prev && span > 0 ? (feesNear(prev, p, false) / tvl(p)) * (365 / span) : null,
      shareValueNear: (2 * toNear(p.rN)) / Number(p.shares),
    };
  });
  let fees = 0;
  let tvlSum = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    fees += feesNear(a, b, true);
    tvlSum += (tvl(a) + tvl(b)) / 2;
  }
  const meanTvl = tvlSum / (points.length - 1);
  const feeAprRealized = (fees / meanTvl) * (365 / days);

  // LP vs HODL from share values, both in NEAR at the END pool price.
  const s0 = Number(first.shares);
  const a0 = toNear(first.rN) / s0; // NEAR per share at the start
  const b0 = Number(first.rO) / s0; // other raw per share at the start
  const pEnd = toNear(last.rN) / Number(last.rO);
  const hodlEnd = a0 + b0 * pEnd;
  const svEnd = (2 * toNear(last.rN)) / Number(last.shares);
  const svStart = 2 * a0;
  const lpVsHodlWindow = svEnd / hodlEnd - 1;
  const r = pEnd / (toNear(first.rN) / Number(first.rO));
  const ilWindow = (2 * Math.sqrt(r)) / (1 + r) - 1;

  const gasNear = toNear(costs.roundTripGas * costs.gasPriceYocto);
  const cost = (usd: number) =>
    costs.nearUsd === null
      ? null
      : roundTripCostNear(last, usd / costs.nearUsd, gasNear) * costs.nearUsd;
  const c500 = cost(500);
  const c5000 = cost(5_000);
  const lpVsHodlApr = lpVsHodlWindow * (365 / days);
  const noms = daily.flatMap((d) => (d.nominalApr24h === null ? [] : [d.nominalApr24h]));
  const nominalEnd = daily[daily.length - 1]?.nominalApr24h ?? null;
  return {
    daily,
    metrics: {
      pool,
      other,
      feeBps: last.feeBps,
      firstDate: daily[0]?.date ?? '',
      days,
      tvlNearEnd: tvl(last),
      tvlUsdEnd: costs.nearUsd === null ? null : tvl(last) * costs.nearUsd,
      nominalApr24hEnd: nominalEnd,
      nominalApr24hMin: noms.length ? Math.min(...noms) : null,
      nominalApr24hMedian: median(noms),
      nominalApr24hMax: noms.length ? Math.max(...noms) : null,
      feeAprRealized,
      ilWindow,
      lpVsHodlWindow,
      lpVsHodlApr,
      lpReturnInNearApr: (svEnd / svStart - 1) * (365 / days),
      roundTripCostUsd500: c500,
      roundTripCostUsd5000: c5000,
      netApr500: c500 === null ? null : lpVsHodlApr - (c500 / 500) * (365 / days),
      netApr5000: c5000 === null ? null : lpVsHodlApr - (c5000 / 5_000) * (365 / days),
      gap: nominalEnd === null ? null : nominalEnd - lpVsHodlApr,
    },
  };
}

// ------------------------------------------------------------------------------------------------ Burrow

export interface BurrowMetrics {
  readonly token: string;
  readonly days: number;
  readonly supplyAprEnd: number;
  readonly supplyAprMin: number;
  readonly supplyAprMax: number;
  readonly supplyAprRealized: number;
  readonly borrowAprEnd: number;
  readonly utilizationEnd: number;
}

export function burrowMetrics(
  lines: readonly BurrowLine[],
  times: ReadonlyMap<number, number>,
): BurrowMetrics[] {
  const sorted = [...lines].sort((a, b) => a.height - b.height);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return [];
  const out: BurrowMetrics[] = [];
  for (const end of last.assets) {
    const series = sorted.flatMap((l) => {
      const a = l.assets.find((x) => x.token_id === end.token_id);
      const t = times.get(l.height);
      return a && t !== undefined && BigInt(a.supplied.shares) > 0n ? [{ t, a }] : [];
    });
    const s0 = series[0];
    const s1 = series[series.length - 1];
    if (!s0 || !s1 || series.length < 8) continue;
    const px = (a: (typeof series)[number]['a']) =>
      Number((BigInt(a.supplied.balance) * 10n ** 12n) / BigInt(a.supplied.shares)) / 1e12;
    const days = (s1.t - s0.t) / DAY;
    const aprs = series.map((s) => Number(s.a.supply_apr));
    // Burrow lends out its protocol reserve too: utilisation = borrowed / (supplied + reserved).
    const supplied = Number(BigInt(s1.a.supplied.balance) + BigInt(s1.a.reserved));
    out.push({
      token: end.token_id,
      days,
      supplyAprEnd: Number(s1.a.supply_apr),
      supplyAprMin: Math.min(...aprs),
      supplyAprMax: Math.max(...aprs),
      supplyAprRealized: (px(s1.a) / px(s0.a) - 1) * (365 / days),
      borrowAprEnd: Number(s1.a.borrow_apr),
      utilizationEnd: supplied > 0 ? Number(BigInt(s1.a.borrowed.balance)) / supplied : 0,
    });
  }
  return out.sort((a, b) => (a.token < b.token ? -1 : 1));
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rank = (v: readonly number[]) => {
    const idx = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1]?.x === idx[i]?.x) j += 1;
      for (let k = i; k <= j; k += 1) r[idx[k]?.i ?? 0] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = (n + 1) / 2;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = (rx[i] ?? 0) - mx;
    const b = (ry[i] ?? 0) - mx;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}
