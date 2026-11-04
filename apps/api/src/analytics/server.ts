import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SHADOW_BANNER } from '../collector/model';
import type { CollectorStore } from '../collector/store';
import { MAINNET_ASSETS } from '../market-data/assets';
import { deviationBps, parseDecimal } from '../market-data/decimal';

/**
 * READ-ONLY analytics API over what the collector stored. It never reads the chain or a price API, never starts a
 * cycle, and never returns a secret: every handler is a SELECT.
 */
export interface AnalyticsDeps {
  readonly apiToken: string;
  readonly store: CollectorStore;
  readonly intervalSeconds: number;
  readonly now?: () => Date;
}

const digest = (s: string) => createHash('sha256').update(s).digest();

export function buildAnalyticsServer(
  deps: AnalyticsDeps,
  opts: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const now = deps.now ?? (() => new Date());
  const expected = digest(deps.apiToken);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!timingSafeEqual(digest(token), expected))
      await reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/health', async () => ({ ok: true }));

  app.get('/v1/analytics/overview', async () => {
    const [cycles, snapshot, pools, markets] = await Promise.all([
      deps.store.recentCycles(200),
      deps.store.latestSnapshot(),
      deps.store.pools(),
      deps.store.markets(),
    ]);
    const last = cycles[0] ?? null;
    const lastOk = cycles.find((c) => c.status === 'success' || c.status === 'partial') ?? null;
    const count = <T>(xs: readonly T[], f: (x: T) => string) =>
      xs.reduce<Record<string, number>>((m, x) => ({ ...m, [f(x)]: (m[f(x)] ?? 0) + 1 }), {});
    const analyses = snapshot ? await deps.store.analysesForSnapshot(snapshot.id) : [];
    const sources =
      (lastOk?.sources as
        { source: string; health: string; detail: string | null }[] | undefined) ?? [];
    const latestMarkets = markets.map(
      (m) =>
        m.latest as { status: string; activeRewardProgrammes: number; supplyApr: string | null },
    );
    return {
      banner: SHADOW_BANNER,
      generatedAt: now().toISOString(),
      collector: {
        running: last?.status === 'running',
        lastStartedAt: last?.startedAt ?? null,
        lastCompletedAt: lastOk?.finishedAt ?? null,
        nextRunAt: last
          ? new Date(last.startedAt.getTime() + deps.intervalSeconds * 1000).toISOString()
          : null,
        lastDurationMs: lastOk?.durationMs ?? null,
        successfulCycles: cycles.filter((c) => c.status === 'success').length,
        partialCycles: cycles.filter((c) => c.status === 'partial').length,
        failedCycles: cycles.filter((c) => c.status === 'failed').length,
        lastError: cycles.find((c) => c.error)?.error ?? null,
        collectedRecords: lastOk?.records ?? 0,
        activeSources: sources
          .filter((s) => s.health === 'ok' || s.health === 'degraded')
          .map((s) => s.source),
        sources,
        intervalSeconds: deps.intervalSeconds,
        cyclesShown: cycles.length,
      },
      snapshot: snapshot && {
        id: snapshot.id,
        blockHeight: snapshot.blockHeight,
        blockTimestamp: snapshot.blockTimestamp,
        takenAt: snapshot.takenAt,
        ageSeconds: Math.round((now().getTime() - snapshot.takenAt.getTime()) / 1000),
        summary: snapshot.summary,
      },
      rhea: {
        discovered: pools.length,
        active: pools.filter((p) => p.active).length,
        byCategory: count(pools, (p) => p.category),
        byFamily: count(pools, (p) => p.family),
        liquid: pools.filter((p) =>
          ['LIQUID', 'ANALYTICS_ELIGIBLE', 'LP_SIMULATION_ELIGIBLE', 'UNSUPPORTED'].includes(
            p.category,
          ),
        ).length,
        lpEligible: pools.filter((p) => p.category === 'LP_SIMULATION_ELIGIBLE').length,
      },
      burrow: {
        markets: markets.length,
        supported: latestMarkets.filter((m) => m.status === 'OK').length,
        withRewards: latestMarkets.filter((m) => m.activeRewardProgrammes > 0).length,
        byStatus: count(latestMarkets, (m) => m.status),
        opportunities: latestMarkets.filter((m) => m.status === 'OK' && m.supplyApr !== null)
          .length,
      },
      portfolios: analyses.map((a) => ({
        portfolioId: a.portfolioId,
        outcome: a.outcome,
        runId: a.runId,
      })),
    };
  });

  app.get('/v1/analytics/collector', async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(50) })
      .parse(req.query);
    return { cycles: await deps.store.recentCycles(q.limit) };
  });

  app.get('/v1/analytics/prices', async () => {
    const snapshot = await deps.store.latestSnapshot();
    if (!snapshot) return { snapshot: null, assets: [] };
    const obs = await deps.store.pricesForSnapshot(snapshot.id);
    const curated = MAINNET_ASSETS.map((a) => a.testnetToken);
    const assets = [...new Set(obs.map((o) => o.asset))]
      .sort(
        (a, b) => Number(!curated.includes(a)) - Number(!curated.includes(b)) || a.localeCompare(b),
      )
      .map((asset) => {
        const rows = obs.filter((o) => o.asset === asset);
        const pick = (src: string) =>
          rows.find((r) => r.source === src && r.status === 'valid') ??
          rows.find((r) => r.source === src) ??
          null;
        const pyth = pick('pyth');
        const llama = pick('defillama');
        const a = pyth?.status === 'valid' && pyth.priceUsd ? parseDecimal(pyth.priceUsd) : null;
        const b = llama?.status === 'valid' && llama.priceUsd ? parseDecimal(llama.priceUsd) : null;
        const divergence =
          a && b && a.mantissa > 0n && b.mantissa > 0n ? Number(deviationBps(a, b)) : null;
        const ref = MAINNET_ASSETS.find((x) => x.testnetToken === asset);
        const status =
          !a && !b
            ? 'UNAVAILABLE'
            : a && b
              ? ref && divergence !== null && divergence > ref.maxDeviationBps
                ? 'LOW_CONFIDENCE'
                : 'OK'
              : 'SINGLE_SOURCE';
        return {
          asset,
          curated: curated.includes(asset),
          pyth,
          defillama: llama,
          divergenceBps: divergence,
          maxDeviationBps: ref?.maxDeviationBps ?? null,
          status,
        };
      });
    return {
      snapshot: { id: snapshot.id, blockHeight: snapshot.blockHeight, takenAt: snapshot.takenAt },
      assets,
    };
  });

  app.get('/v1/analytics/prices/:asset', async (req) => {
    const { asset } = z.object({ asset: z.string().min(1).max(200) }).parse(req.params);
    return {
      asset,
      history: await deps.store.priceHistory(asset, new Date(now().getTime() - 30 * 86_400_000)),
    };
  });

  app.get('/v1/analytics/rhea/pools', async (req) => {
    const q = z
      .object({
        token: z.string().max(200).default(''),
        type: z.string().max(50).default(''),
        category: z.string().max(50).default(''),
        minTvl: z.coerce.number().min(0).optional(),
        sort: z.enum(['tvl', 'volume', 'apr']).default('tvl'),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    const all = (await deps.store.pools()).map((p) => {
      const latest = (p.latest ?? {}) as {
        windows?: { window: string; volumeUsd: string | null; annualizedApr: string | null }[];
        tracked?: boolean;
        tvlMethod?: string | null;
        historySeconds?: number;
      };
      return {
        poolKey: p.poolKey,
        family: p.family,
        poolType: p.poolType,
        tokens: p.tokens,
        feeBps: p.feeBps,
        tvlUsd: p.tvlUsd,
        priceQuality: p.priceQuality,
        category: p.category,
        modelStatus: p.modelStatus,
        reasons: p.reasons,
        active: p.active,
        lastSeenAt: p.lastSeenAt,
        tracked: latest.tracked ?? false,
        tvlMethod: latest.tvlMethod ?? null,
        historySeconds: latest.historySeconds ?? 0,
        windows: latest.windows ?? [],
      };
    });
    const n = (v: string | null | undefined) => (v ? Number(v) : 0);
    const w = (p: (typeof all)[number], name: string) => p.windows.find((x) => x.window === name);
    const metric = {
      tvl: (p: (typeof all)[number]) => n(p.tvlUsd),
      volume: (p: (typeof all)[number]) => n(w(p, '24H')?.volumeUsd) || n(w(p, '1H')?.volumeUsd),
      apr: (p: (typeof all)[number]) =>
        n(w(p, '24H')?.annualizedApr) || n(w(p, '1H')?.annualizedApr),
    }[q.sort];
    const matching = all
      .filter((p) => !q.token || p.tokens.some((t) => t.includes(q.token)))
      .filter((p) => !q.type || p.poolType === q.type)
      .filter((p) => !q.category || p.category === q.category)
      .filter((p) => q.minTvl === undefined || n(p.tvlUsd) >= q.minTvl)
      .sort((a, b) => metric(b) - metric(a));
    const counts = all.reduce<Record<string, number>>(
      (m, p) => ({ ...m, [p.category]: (m[p.category] ?? 0) + 1 }),
      {},
    );
    return {
      total: all.length,
      matching: matching.length,
      counts,
      types: [...new Set(all.map((p) => p.poolType))].sort(),
      pools: matching.slice(0, q.limit),
    };
  });

  app.get('/v1/analytics/rhea/pools/:key', async (req, reply) => {
    const { key } = z.object({ key: z.string().min(1).max(300) }).parse(req.params);
    const pool = await deps.store.pool(key);
    if (!pool) return reply.code(404).send({ error: 'unknown pool' });
    return {
      pool,
      history: await deps.store.poolHistory(key, new Date(now().getTime() - 30 * 86_400_000)),
    };
  });

  app.get('/v1/analytics/burrow/markets', async () => ({
    markets: (await deps.store.markets()).map((m) => ({
      ...(m.latest as object),
      lastSeenAt: m.lastSeenAt,
    })),
  }));

  app.get('/v1/analytics/burrow/markets/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(req.params);
    return {
      token,
      history: await deps.store.marketHistory(token, new Date(now().getTime() - 30 * 86_400_000)),
    };
  });

  app.get('/v1/analytics/portfolios', async () => {
    const snapshot = await deps.store.latestSnapshot();
    if (!snapshot) return { snapshot: null, analyses: [] };
    return { snapshot, analyses: await deps.store.analysesForSnapshot(snapshot.id) };
  });

  return app;
}
