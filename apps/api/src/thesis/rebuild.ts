import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  burrowLine,
  burrowMetrics,
  gasLine,
  manifestSchema,
  metaLine,
  nearUsd,
  poolMetrics,
  poolPoints,
  priceLine,
  rheaLine,
  spearman,
  type BurrowMetrics,
  type DailyPoint,
  type PoolMetrics,
} from './analysis';
import { OUT_DIR, RAW_DIR, ROOT } from './paths';
import { tokenLabel } from './labels';
import { thesisMarkdown } from './report';
import { dumbbell, scatterLogX } from './svg';

/**
 * pnpm thesis:rebuild - OFFLINE and deterministic: thesis/data/raw/* -> thesis/out/*.csv, thesis/out/charts/*.svg,
 * THESIS.md. No network, no clock: the same raw files give byte-identical outputs (a test enforces it).
 */
const ROUND_TRIP_GAS = 4n * 180_000_000_000_000n; // swap, add, remove, swap; 180 Tgas attached each: an upper bound

const lines = (file: string) =>
  readFileSync(resolve(RAW_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);

export interface ThesisData {
  readonly manifest: ReturnType<typeof manifestSchema.parse>;
  readonly pools: readonly PoolMetrics[];
  readonly daily: readonly DailyPoint[];
  readonly burrow: readonly BurrowMetrics[];
  readonly nearUsdEnd: number | null;
  readonly nearUsdDays: { readonly priced: number; readonly total: number };
  readonly gasPriceEnd: bigint;
  readonly tvlVsNet: number | null;
  readonly tvlVsNominal: number | null;
  /** The same metrics over the last 30 days, by pool id. */
  readonly pools30: ReadonlyMap<number, PoolMetrics>;
  /**
   * Cohorts of the same metrics: pools still in the top at the end vs pools that were in the top at the start only
   * (they shrank: the survivorship check), and wNEAR/stablecoin vs wNEAR/volatile-token pairs.
   */
  readonly cohorts: readonly Cohort[];
  /** Pool #4512 (wNEAR/USDC) price in USD vs the external NEAR/USD quorum, per day: |difference| in bps. */
  readonly priceCheck: {
    readonly days: number;
    readonly medianBps: number | null;
    readonly maxBps: number | null;
  };
}

export interface Cohort {
  readonly key: 'survivors' | 'shrunk' | 'stable' | 'volatile';
  readonly label: string;
  readonly pools: readonly number[];
  /** Medians, annualised: fees earned (gross), after impermanent loss (LP vs HODL), after costs for $5,000. */
  readonly medianFeeApr: number | null;
  readonly medianLpVsHodlApr: number | null;
  readonly medianNetApr5000: number | null;
  readonly negativeNet5000: number;
}

const STABLES = new Set([
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  'usdt.tether-token.near',
  'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near',
  'a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near',
  '6b175474e89094c44da98b954eedeac495271d0f.factory.bridge.near',
  '853d955acef822db058eb8505911ed77f175b99e.factory.bridge.near',
]);

const median = (xs: readonly number[]): number | null => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? null) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

function cohort(key: Cohort['key'], label: string, list: readonly PoolMetrics[]): Cohort {
  return {
    key,
    label,
    pools: list.map((p) => p.pool),
    medianFeeApr: median(list.map((p) => p.feeAprRealized)),
    medianLpVsHodlApr: median(list.map((p) => p.lpVsHodlApr)),
    medianNetApr5000: median(list.flatMap((p) => (p.netApr5000 === null ? [] : [p.netApr5000]))),
    negativeNet5000: list.filter((p) => p.netApr5000 !== null && p.netApr5000 < 0).length,
  };
}

export function computeThesis(): ThesisData {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(resolve(RAW_DIR, 'manifest.json'), 'utf8')),
  );
  const times = new Map(manifest.blocks.map((b) => [b.height, Date.parse(b.timestamp)]));
  const admin = new Map(
    lines('rhea-metadata.jsonl').map((l) => {
      const m = metaLine.parse(l);
      return [m.height, m.metadata.admin_fee_bps] as const;
    }),
  );
  const gas = lines('gas-price.jsonl').map((l) => gasLine.parse(l));
  const last = manifest.blocks[manifest.blocks.length - 1];
  const gasPriceEnd = BigInt(
    gas.find((g) => g.height === last?.height)?.gas_price.gas_price ?? '100000000',
  );
  const prices = lines('near-usd.jsonl').map((l) => nearUsd(priceLine.parse(l)));
  const nearUsdEnd = prices.find((p) => p.height === last?.height)?.usd ?? null;

  const raw = lines('rhea-pools.jsonl').map((l) => rheaLine.parse(l));
  const otherOf = new Map<number, string>();
  for (const l of raw)
    if (l.get_pool)
      otherOf.set(l.pool, l.get_pool.token_account_ids.find((t) => t !== 'wrap.near') ?? '');
  const points = poolPoints(raw, admin, times);
  const pools: PoolMetrics[] = [];
  const daily: DailyPoint[] = [];
  const pools30 = new Map<number, PoolMetrics>();
  const costs = { nearUsd: nearUsdEnd, gasPriceYocto: gasPriceEnd, roundTripGas: ROUND_TRIP_GAS };
  for (const id of manifest.universe.pools) {
    const pts = points.get(id) ?? [];
    const r = poolMetrics(id, otherOf.get(id) ?? '', pts, costs);
    if (!r) continue;
    pools.push(r.metrics);
    daily.push(...r.daily);
    const r30 = poolMetrics(id, otherOf.get(id) ?? '', pts.slice(-31), costs);
    if (r30) pools30.set(id, r30.metrics);
  }
  // USDC has 6 decimals and trades at ~$1: USD per NEAR from the pool = 1 / (NEAR per raw USDC x 10^6).
  const usdByHeight = new Map(prices.map((p) => [p.height, p.usd]));
  const diffs = (points.get(4512) ?? []).flatMap((p) => {
    const ext = usdByHeight.get(p.height);
    if (ext === null || ext === undefined) return [];
    const internal = Number(p.rO) / 1e6 / (Number(p.rN) / 1e24);
    return [(Math.abs(internal - ext) / ext) * 10_000];
  });
  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const priceCheck = {
    days: diffs.length,
    medianBps: sortedDiffs.length
      ? (sortedDiffs[Math.floor(sortedDiffs.length / 2)] ?? null)
      : null,
    maxBps: sortedDiffs.length ? (sortedDiffs[sortedDiffs.length - 1] ?? null) : null,
  };
  const burrow = burrowMetrics(
    lines('burrow-assets.jsonl').map((l) => burrowLine.parse(l)),
    times,
  );
  const priced = pools.filter((p) => p.tvlUsdEnd !== null && p.netApr500 !== null);
  const endSet = new Set(manifest.universe.endPools ?? manifest.universe.pools);
  const cohorts: Cohort[] = [
    cohort(
      'survivors',
      'still in the top 15 at the end',
      pools.filter((p) => endSet.has(p.pool)),
    ),
    ...(manifest.universe.startPools
      ? [
          cohort(
            'shrunk',
            'in the top 15 at the start only (shrank)',
            pools.filter((p) => !endSet.has(p.pool)),
          ),
        ]
      : []),
    cohort(
      'stable',
      'wNEAR / stablecoin',
      pools.filter((p) => STABLES.has(p.other)),
    ),
    cohort(
      'volatile',
      'wNEAR / volatile token',
      pools.filter((p) => !STABLES.has(p.other)),
    ),
  ];
  return {
    manifest,
    cohorts,
    pools,
    daily,
    burrow,
    nearUsdEnd,
    nearUsdDays: { priced: prices.filter((p) => p.usd !== null).length, total: prices.length },
    gasPriceEnd,
    tvlVsNet: spearman(
      priced.map((p) => p.tvlNearEnd),
      priced.map((p) => p.lpVsHodlApr),
    ),
    pools30,
    priceCheck,
    tvlVsNominal: spearman(
      pools.filter((p) => p.nominalApr24hEnd !== null).map((p) => p.tvlNearEnd),
      pools.flatMap((p) => (p.nominalApr24hEnd === null ? [] : [p.nominalApr24hEnd])),
    ),
  };
}

const f = (v: number | null, digits = 6) =>
  v === null || !Number.isFinite(v) ? '' : v.toFixed(digits);

function csv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (c: string | number) => {
    const s = String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

export function renderOutputs(d: ThesisData): Record<string, string> {
  const files: Record<string, string> = {};
  files['thesis/out/pools.csv'] = csv([
    [
      'pool',
      'other_token',
      'fee_bps',
      'first_date',
      'days',
      'tvl_near_end',
      'tvl_usd_end',
      'nominal_apr_24h_end',
      'nominal_apr_24h_min',
      'nominal_apr_24h_median',
      'nominal_apr_24h_max',
      'fee_apr_realized',
      'il_window',
      'lp_vs_hodl_window',
      'lp_vs_hodl_apr',
      'lp_return_in_near_apr',
      'round_trip_cost_usd_500',
      'round_trip_cost_usd_5000',
      'net_apr_500',
      'net_apr_5000',
      'gap_nominal_minus_lp_vs_hodl',
      'fee_apr_realized_30d',
      'lp_vs_hodl_apr_30d',
      'net_apr_500_30d',
    ],
    ...d.pools.map((p) => [
      p.pool,
      p.other,
      p.feeBps,
      p.firstDate,
      f(p.days, 3),
      f(p.tvlNearEnd, 3),
      f(p.tvlUsdEnd, 2),
      f(p.nominalApr24hEnd),
      f(p.nominalApr24hMin),
      f(p.nominalApr24hMedian),
      f(p.nominalApr24hMax),
      f(p.feeAprRealized),
      f(p.ilWindow),
      f(p.lpVsHodlWindow),
      f(p.lpVsHodlApr),
      f(p.lpReturnInNearApr),
      f(p.roundTripCostUsd500, 4),
      f(p.roundTripCostUsd5000, 4),
      f(p.netApr500),
      f(p.netApr5000),
      f(p.gap),
      f(d.pools30.get(p.pool)?.feeAprRealized ?? null),
      f(d.pools30.get(p.pool)?.lpVsHodlApr ?? null),
      f(d.pools30.get(p.pool)?.netApr500 ?? null),
    ]),
  ]);
  files['thesis/out/pools-daily.csv'] = csv([
    [
      'pool',
      'date',
      'block_height',
      'tvl_near',
      'price_near_per_other_raw',
      'nominal_apr_24h',
      'share_value_near',
    ],
    ...d.daily.map((x) => [
      x.pool,
      x.date,
      x.height,
      f(x.tvlNear, 3),
      x.priceNearPerOther.toExponential(9),
      f(x.nominalApr24h),
      x.shareValueNear.toExponential(12),
    ]),
  ]);
  files['thesis/out/burrow.csv'] = csv([
    [
      'token',
      'days',
      'supply_apr_end',
      'supply_apr_min',
      'supply_apr_max',
      'supply_apr_realized',
      'borrow_apr_end',
      'utilization_end',
    ],
    ...d.burrow.map((b) => [
      b.token,
      f(b.days, 3),
      f(b.supplyAprEnd),
      f(b.supplyAprMin),
      f(b.supplyAprMax),
      f(b.supplyAprRealized),
      f(b.borrowAprEnd),
      f(b.utilizationEnd),
    ]),
  ]);

  const byTvl = [...d.pools].sort((a, b) => b.tvlNearEnd - a.tvlNearEnd);
  files['thesis/out/charts/nominal-vs-realized.svg'] = dumbbell({
    title: 'What the pool list shows vs what an LP kept, top wNEAR pools on Rhea',
    subtitle: `Annualised. ${d.manifest.days} days to ${d.manifest.end.slice(0, 10)}; pools by TVL, largest first. Values in NEAR at each pool's own price.`,
    series: [
      'Nominal APR (last 24h fees)',
      `LP vs HODL (${d.manifest.days}d, fees − IL)`,
      `Fee APR realized (${d.manifest.days}d)`,
    ],
    rows: byTvl.map((p) => ({
      label: `#${p.pool} wNEAR/${tokenLabel(p.other)}`,
      values: [p.nominalApr24hEnd, p.lpVsHodlApr, p.feeAprRealized],
      note: p.tvlUsdEnd === null ? undefined : `TVL $${Math.round(p.tvlUsdEnd)}`,
    })),
    clamp: [-1, 1.5],
  });
  const sc = d.pools.filter((p) => p.tvlUsdEnd !== null);
  const sorted = [...sc].sort((a, b) => a.lpVsHodlApr - b.lpVsHodlApr);
  files['thesis/out/charts/tvl-vs-lp-vs-hodl.svg'] = scatterLogX({
    title: 'TVL does not rank the outcome',
    subtitle: `LP vs HODL over ${d.manifest.days} days (annualised) against TVL at the end. Spearman ρ = ${d.tvlVsNet === null ? 'n/a' : d.tvlVsNet.toFixed(2)}.`,
    xLabel: 'TVL at the end (USD, log scale)',
    yLabel: 'LP vs HODL, annualised',
    points: sc.map((p) => ({
      x: p.tvlUsdEnd ?? 1,
      y: p.lpVsHodlApr,
      label: `#${p.pool} ${tokenLabel(p.other)}`,
    })),
    labelled: [sorted[0], sorted[sorted.length - 1], byTvl[0]].flatMap((p) =>
      p ? [`#${p.pool} ${tokenLabel(p.other)}`] : [],
    ),
  });
  const bw = d.burrow.filter((b) => b.supplyAprEnd > 0 || b.supplyAprRealized > 0);
  files['thesis/out/charts/burrow-supply.svg'] = dumbbell({
    title: 'Burrow: the supply APR shown today vs the supply yield actually accrued',
    subtitle: `Realized = growth of the supply share price over ${d.manifest.days} days, annualised. Incentives (farms) excluded from both.`,
    series: ['Supply APR at the end block', `Realized supply APR (${d.manifest.days}d)`],
    rows: [...bw]
      .sort((a, b) => b.supplyAprEnd - a.supplyAprEnd)
      .map((b) => ({ label: tokenLabel(b.token), values: [b.supplyAprEnd, b.supplyAprRealized] })),
  });
  files['THESIS.md'] = thesisMarkdown(d);
  return files;
}

function main(): void {
  const files = renderOutputs(computeThesis());
  for (const [path, content] of Object.entries(files)) {
    const abs = resolve(ROOT, path);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  process.stdout.write(`thesis rebuilt: ${Object.keys(files).join(', ')}\n`);
}

if (process.argv[1]?.endsWith('rebuild.ts')) main();
export { OUT_DIR };
