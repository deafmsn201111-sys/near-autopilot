import { orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CollectorStore } from '../collector/store';
import { MAINNET_ASSETS } from '../market-data/assets';
import { deviationBps, parseDecimal } from '../market-data/decimal';

/**
 * READ-ONLY time series for the charts: prices (with the spread between sources), Rhea pool TVL, Burrow rates and the
 * demo portfolios' risk as the decision engine computed it. Every value is a stored observation or a stored result of
 * the engine; nothing is interpolated, smoothed or extrapolated here.
 */
const hoursQuery = (def: number) =>
  z.object({
    hours: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(def),
  });

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Quote {
  readonly source: string;
  readonly priceUsd: string | null;
  readonly quoteCurrency: string;
  readonly status: string;
}

/** The USD-quoted, valid quotes of one asset in one snapshot: their median and the widest pairwise spread (bps). */
export function consensus(quotes: readonly Quote[]): {
  price: number | null;
  spreadBps: number | null;
  sources: number;
} {
  const valid = quotes.flatMap((q) => {
    if (q.status !== 'valid' || q.quoteCurrency !== 'USD' || !q.priceUsd) return [];
    const d = parseDecimal(q.priceUsd);
    return d && d.mantissa > 0n ? [{ d, n: Number(q.priceUsd) }] : [];
  });
  if (valid.length === 0) return { price: null, spreadBps: null, sources: 0 };
  const sorted = valid.map((v) => v.n).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const price =
    sorted.length % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  let spread: number | null = null;
  for (const a of valid)
    for (const b of valid) {
      const s = Number(deviationBps(a.d, b.d));
      spread = spread === null ? s : Math.max(spread, s);
    }
  return { price, spreadBps: valid.length > 1 ? spread : null, sources: valid.length };
}

/** HF bands the orchestrator classifies risk with (config.orchestrator.risk; its defaults when not overridden). */
export function riskBands(override?: unknown) {
  const r = orchestratorConfigSchema.parse(override ? { risk: override } : {}).risk;
  return {
    watch: r.watchBelowBps / 10_000,
    danger: r.dangerBelowBps / 10_000,
    critical: r.criticalBelowBps / 10_000,
    target: r.targetHealthFactorBps / 10_000,
    liquidation: 1,
  };
}

interface StoredRisk {
  level?: string;
  ltvBps?: string | null;
  healthFactorWad?: string | null;
  collateralUsdMicro?: string | null;
  debtUsdMicro?: string | null;
  stress?: { scenario: string; status: string; healthFactorWad: string | null }[];
}
/** The engine's stored risk block (JSON written by the collector), or null when the analysis had none. */
const storedRisk = (v: unknown): StoredRisk | null =>
  v !== null && typeof v === 'object' ? v : null;
const wad = (v: string | null | undefined) => (v ? Number(BigInt(v) / 10n ** 12n) / 1e6 : null);

export function registerSeries(
  app: FastifyInstance,
  store: CollectorStore,
  now: () => Date,
  riskOverride?: unknown,
): void {
  const since = (hours: number) => new Date(now().getTime() - hours * 3_600_000);

  app.get('/v1/analytics/series/prices', async (req) => {
    const { hours } = hoursQuery(48).parse(req.query);
    const rows = await store.priceSeries(since(hours));
    const groups = new Map<string, Map<string, { t: number; quotes: Quote[] }>>();
    for (const r of rows) {
      const byAsset = groups.get(r.asset) ?? new Map<string, { t: number; quotes: Quote[] }>();
      groups.set(r.asset, byAsset);
      const snap = byAsset.get(r.snapshotId) ?? { t: r.observedAt.getTime(), quotes: [] };
      snap.t = Math.min(snap.t, r.observedAt.getTime());
      snap.quotes.push(r);
      byAsset.set(r.snapshotId, snap);
    }
    return {
      hours,
      assets: [...groups].map(([asset, snaps]) => {
        const ref = MAINNET_ASSETS.find((a) => a.token === asset);
        return {
          asset,
          curated: ref !== undefined,
          maxDeviationBps: ref?.maxDeviationBps ?? null,
          // The multi-source price needs its sources within this (NEAR: 150 bps); else the asset's own limit.
          limitBps: ref?.quorum?.maxDeviationBps ?? ref?.maxDeviationBps ?? null,
          points: [...snaps.values()]
            .sort((a, b) => a.t - b.t)
            .map((s) => ({ t: s.t, ...consensus(s.quotes) })),
        };
      }),
    };
  });

  app.get('/v1/analytics/series/pools', async (req) => {
    const { hours } = hoursQuery(24).parse(req.query);
    const pools = new Map<string, { t: number; tvl: number | null }[]>();
    for (const r of await store.poolTvlSeries(since(hours))) {
      const list = pools.get(r.poolKey) ?? [];
      list.push({ t: r.at.getTime(), tvl: num(r.tvlUsd) });
      pools.set(r.poolKey, list);
    }
    return { hours, pools: [...pools].map(([poolKey, points]) => ({ poolKey, points })) };
  });

  app.get('/v1/analytics/series/markets', async (req) => {
    const { hours } = hoursQuery(48).parse(req.query);
    const markets = new Map<
      string,
      {
        t: number;
        supplyApr: number | null;
        borrowApr: number | null;
        utilization: number | null;
      }[]
    >();
    for (const r of await store.marketSeries(since(hours))) {
      const list = markets.get(r.token) ?? [];
      list.push({
        t: r.at.getTime(),
        supplyApr: num(r.supplyApr),
        borrowApr: num(r.borrowApr),
        utilization: num(r.utilization),
      });
      markets.set(r.token, list);
    }
    return { hours, markets: [...markets].map(([token, points]) => ({ token, points })) };
  });

  app.get('/v1/analytics/risk', async (req) => {
    const { hours } = hoursQuery(72).parse(req.query);
    const rows = await store.riskSeries(since(hours));
    const ids = [...new Set(rows.map((r) => r.portfolioId))].sort();
    return {
      hours,
      dataSource: 'simulation',
      label: 'SIMULATED demo portfolios, valued at real mainnet prices. Not an on-chain position.',
      bands: riskBands(riskOverride),
      portfolios: ids.map((id) => {
        const mine = rows.filter((r) => r.portfolioId === id);
        const last = mine[mine.length - 1];
        const risk = storedRisk(last?.risk);
        const hf = wad(risk?.healthFactorWad);
        return {
          portfolioId: id,
          description: last?.description ?? null,
          latest: risk && {
            at: last?.at.toISOString() ?? null,
            level: risk.level ?? null,
            healthFactor: hf,
            ltvBps: num(risk.ltvBps),
            collateralUsd:
              num(risk.collateralUsdMicro) === null ? null : Number(risk.collateralUsdMicro) / 1e6,
            debtUsd: num(risk.debtUsdMicro) === null ? null : Number(risk.debtUsdMicro) / 1e6,
            stress: (risk.stress ?? []).map((s) => ({
              scenario: s.scenario,
              status: s.status,
              healthFactor: wad(s.healthFactorWad),
            })),
            // A uniform drop of every collateral price scales the adjusted collateral linearly while the debt stays,
            // so HF(d) = HF * (1 - d) and the position becomes liquidatable below HF 1 at d = 1 - 1/HF.
            collateralDropToLiquidation: hf !== null && hf > 1 ? 1 - 1 / hf : null,
          },
          history: mine.map((r) => {
            const x = storedRisk(r.risk);
            return {
              t: r.at.getTime(),
              healthFactor: wad(x?.healthFactorWad),
              level: x?.level ?? null,
            };
          }),
        };
      }),
    };
  });
}
