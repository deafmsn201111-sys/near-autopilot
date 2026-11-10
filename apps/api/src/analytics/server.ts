import { orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import type { ProvenanceTier } from '@near-autopilot/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SHADOW_BANNER } from '../collector/model';
import type { CollectorStore } from '../collector/store';
import type { EvidenceStore } from '../evidence/store';
import { registerEvidence } from './evidence';
import { registerSeries } from './series';
import { registerActivity } from './activity';
import { registerPortfolioView } from './portfolio-view';
import { registerAccountView, type MainnetReadDeps } from './account-view';
import { ControlError, type ControlService } from '../control/service';
import { estimateDcl, type DclEstimate } from './dcl';
import { rankOpportunities, type SimulationInput } from './opportunities';
import { MAINNET_ASSETS } from '../market-data/assets';
import { deviationBps, parseDecimal } from '../market-data/decimal';

/**
 * READ-ONLY analytics API over what the collector stored. It never reads the chain or a price API, never starts a
 * cycle, and never returns a secret: every handler is a SELECT.
 */
export interface AnalyticsDeps {
  readonly apiToken: string;
  readonly store: CollectorStore;
  /** Verdicts, audit chains, routes (absent in tests that do not need them). */
  readonly evidence?: EvidenceStore;
  readonly intervalSeconds: number;
  readonly now?: () => Date;
  /** Operator controls (pause/resume collection, read-only mode). Absent: the /v1/control routes are not served. */
  readonly control?: ControlService;
  /** The collector's internal HTTP endpoint, for "run an analysis now". */
  readonly collectorUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Pinned public key (and file) to verify the signed audit checkpoints against. */
  readonly checkpoints?: { readonly publicKey: string; readonly file?: string | undefined };
  /** Read-only mainnet access for "your account" (view calls only). Absent: the route is not served. */
  readonly mainnet?: MainnetReadDeps;
}

const ORCH_SWAP = orchestratorConfigSchema.parse({}).swap;
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
  if (deps.evidence)
    registerEvidence(
      app,
      deps.evidence,
      deps.checkpoints && deps.store.db ? { ...deps.checkpoints, db: deps.store.db } : undefined,
    );
  registerSeries(app, deps.store, now);
  registerActivity(app, deps.store, deps.store.db, deps.intervalSeconds, now);
  registerPortfolioView(app, deps.store);
  if (deps.mainnet) registerAccountView(app, deps.store, deps.mainnet);
  if (deps.control) registerControl(app, deps.control, deps);

  /** How old the stored data is, for the header of every page (cheap: the last few cycles only). */
  app.get('/v1/analytics/freshness', async () => {
    const cycles = await deps.store.recentCycles(20);
    const last = cycles[0] ?? null;
    const lastOk = cycles.find((c) => c.status === 'success' || c.status === 'partial') ?? null;
    return {
      now: now().toISOString(),
      running: last?.status === 'running',
      lastStatus: lastOk?.status ?? null,
      dataAsOf: lastOk?.finishedAt ?? lastOk?.startedAt ?? null,
      nextRunAt: last
        ? new Date(last.startedAt.getTime() + deps.intervalSeconds * 1000).toISOString()
        : null,
      intervalSeconds: deps.intervalSeconds,
    };
  });

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
    const curated = MAINNET_ASSETS.map((a) => a.token);
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
        const ref = MAINNET_ASSETS.find((x) => x.token === asset);
        // Every source of this asset (Pyth, DefiLlama and the NEAR exchanges), one row each. The status is judged on the
        // USD-quoted valid ones: a USDT quote (Binance) is shown as quoted, converted only inside the price service.
        const sources = [...new Set(rows.map((r) => r.source))].sort().map((src) => pick(src));
        const usdValid = sources.flatMap((r) =>
          r && r.status === 'valid' && r.quoteCurrency === 'USD' && r.priceUsd
            ? [parseDecimal(r.priceUsd)]
            : [],
        );
        let spread: number | null = null;
        for (const x of usdValid)
          for (const y of usdValid)
            if (x && y && x.mantissa > 0n && y.mantissa > 0n) {
              const d = Number(deviationBps(x, y));
              spread = spread === null ? d : Math.max(spread, d);
            }
        const status =
          usdValid.length === 0
            ? 'UNAVAILABLE'
            : usdValid.length === 1
              ? 'SINGLE_SOURCE'
              : ref && spread !== null && spread > ref.maxDeviationBps
                ? 'LOW_CONFIDENCE'
                : 'CORROBORATED';
        return {
          asset,
          curated: curated.includes(asset),
          pyth,
          defillama: llama,
          divergenceBps: divergence,
          spreadBps: spread,
          maxDeviationBps: ref?.maxDeviationBps ?? null,
          sources,
          status,
          // Every price here is an external-market reading (oracle + exchanges), cross-checked — not an on-chain fact.
          provenance: 'external_market' satisfies ProvenanceTier,
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

  /** Symbols and decimals as the token contracts report them (untrusted labels; the UI marks curated ones). */
  app.get('/v1/analytics/tokens', async () => ({
    tokens: (await deps.store.tokenMetadata())
      .map((t) => ({ token: t.token, symbol: t.symbol, decimals: t.decimals }))
      .sort((a, b) => (a.token < b.token ? -1 : 1)),
  }));

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

  /** The ranked, explained opportunity list (Rhea LP + Burrow supply). Read-only; never an instruction to trade. */
  const opportunities = async () => {
    const [pools, markets, tokens, snapshot] = await Promise.all([
      deps.store.pools(),
      deps.store.markets(),
      deps.store.tokenMetadata(),
      deps.store.latestSnapshot(),
    ]);
    const analyses = snapshot ? await deps.store.analysesForSnapshot(snapshot.id) : [];
    const simulations: SimulationInput[] = analyses.map((a) => {
      const r = a.result as {
        portfolio?: { capitalUsd?: number | null };
        lpSimulations?: SimulationInput['lp'];
      };
      return {
        portfolioId: a.portfolioId,
        capitalUsd: r.portfolio?.capitalUsd ?? null,
        lp: r.lpSimulations ?? [],
      };
    });
    // DCL pools: estimated from their stored observations (last 7 days), with confirmed prices only.
    const summary = (snapshot?.summary ?? {}) as {
      prices?: { token: string; usd: string; quality: string }[];
    };
    const okPrices = new Map(
      (summary.prices ?? [])
        .filter((x) => x.quality === 'OK')
        .map((x) => [x.token, Number(x.usd)] as const),
    );
    const refCapital = Math.max(...simulations.map((x) => x.capitalUsd ?? 0), 0) || 1000;
    const dcl = new Map<string, DclEstimate>();
    for (const p of pools) {
      if (p.family !== 'dcl' || !p.active || p.category !== 'UNSUPPORTED') continue;
      const latest = (p.latest ?? {}) as { decimals?: [number, number]; raw?: { feePpm?: number } };
      const [tx, ty] = p.tokens as [string, string];
      const px = okPrices.get(tx);
      const py = okPrices.get(ty);
      if (
        px === undefined ||
        py === undefined ||
        !latest.decimals ||
        latest.raw?.feePpm === undefined
      )
        continue;
      const hist = await deps.store.poolHistory(
        p.poolKey,
        new Date(now().getTime() - 7 * 86_400_000),
      );
      dcl.set(
        p.poolKey,
        estimateDcl({
          points: hist.map((h) => {
            const r = (h.raw ?? {}) as Record<string, string | undefined>;
            return {
              at: h.blockTimestamp,
              point: Number(r['currentPoint']),
              liquidity: BigInt(r['liquidity'] ?? '0'),
              feeX: BigInt(r['totalFeeXCharged'] ?? '0'),
              feeY: BigInt(r['totalFeeYCharged'] ?? '0'),
            };
          }),
          feePpm: latest.raw.feePpm,
          decimals: latest.decimals,
          pricesUsd: [px, py],
          capitalUsd: refCapital,
          horizonDays: ORCH_SWAP.horizonDays,
          gasUsdPerTx: ORCH_SWAP.estimatedGasUsd,
        }),
      );
    }
    return rankOpportunities({
      dcl,
      pools,
      markets,
      simulations,
      symbols: new Map(tokens.map((t) => [t.token, t.symbol])),
      now: now(),
      intervalSeconds: deps.intervalSeconds,
      // the orchestrator's own cost assumptions (the same the hurdle uses)
      gasUsdPerTx: ORCH_SWAP.estimatedGasUsd,
      horizonDays: ORCH_SWAP.horizonDays,
    });
  };

  app.get('/v1/analytics/opportunities', async (req) => {
    const q = z
      .object({
        protocol: z.enum(['', 'rhea', 'burrow']).default(''),
        status: z.enum(['', 'candidate', 'watch', 'insufficient_data']).default(''),
        risk: z.enum(['', 'low', 'medium', 'high']).default(''),
        minLiquidity: z.coerce.number().min(0).optional(),
        sort: z.enum(['score', 'risk', 'net', 'gross', 'liquidity', 'fresh']).default('score'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const { opportunities: all, excluded } = await opportunities();
    const n = (v: number | null) => v ?? -Infinity;
    const sorters = {
      score: () => 0,
      risk: (a: (typeof all)[number], b: (typeof all)[number]) => a.risk.score - b.risk.score,
      net: (a: (typeof all)[number], b: (typeof all)[number]) => n(b.netApr) - n(a.netApr),
      gross: (a: (typeof all)[number], b: (typeof all)[number]) => n(b.grossApr) - n(a.grossApr),
      liquidity: (a: (typeof all)[number], b: (typeof all)[number]) =>
        n(b.liquidityUsd) - n(a.liquidityUsd),
      fresh: (a: (typeof all)[number], b: (typeof all)[number]) =>
        a.dataAgeSeconds - b.dataAgeSeconds,
    };
    const list = all
      .filter((o) => !q.protocol || o.protocol === q.protocol)
      .filter((o) => !q.status || o.status === q.status)
      .filter((o) => !q.risk || o.risk.level === q.risk)
      .filter((o) => q.minLiquidity === undefined || (o.liquidityUsd ?? 0) >= q.minLiquidity);
    if (q.sort !== 'score') list.sort(sorters[q.sort]);
    return {
      generatedAt: now().toISOString(),
      method:
        'score = 0.45 x yield (capped at 40% APR) + 0.35 x (100 - risk) + 0.20 x confidence; halved below $50k liquidity. An ordering aid, not a forecast or a recommendation to trade.',
      total: all.length,
      counts: {
        candidate: all.filter((o) => o.status === 'candidate').length,
        watch: all.filter((o) => o.status === 'watch').length,
        insufficient_data: all.filter((o) => o.status === 'insufficient_data').length,
      },
      excluded,
      matching: list.length,
      opportunities: list.slice(0, q.limit),
    };
  });

  app.get('/v1/analytics/opportunities/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(320) }).parse(req.params);
    const { opportunities: all } = await opportunities();
    const o = all.find((x) => x.id === id);
    if (!o) return reply.code(404).send({ error: 'unknown opportunity' });
    const since = new Date(now().getTime() - 30 * 86_400_000);
    const history =
      o.protocol === 'rhea'
        ? (await deps.store.poolHistory(o.ref, since)).map((h) => ({
            t: h.blockTimestamp.getTime(),
            tvlUsd: h.tvlUsd === null ? null : Number(h.tvlUsd),
            priceQuality: h.priceQuality,
          }))
        : (await deps.store.marketHistory(o.ref, since)).map((h) => ({
            t: h.blockTimestamp.getTime(),
            supplyApr: h.supplyApr === null ? null : Number(h.supplyApr),
            borrowApr: h.borrowApr === null ? null : Number(h.borrowApr),
            utilization: h.utilization === null ? null : Number(h.utilization),
          }));
    return { opportunity: o, rank: all.indexOf(o) + 1, of: all.length, history };
  });

  app.get('/v1/analytics/portfolios', async () => {
    const snapshot = await deps.store.latestSnapshot();
    if (!snapshot) return { snapshot: null, analyses: [] };
    return { snapshot, analyses: await deps.store.analysesForSnapshot(snapshot.id) };
  });

  return app;
}

const actor = z.object({
  by: z.string().trim().min(1).max(80),
  reason: z.string().trim().min(3).max(300),
});

/**
 * The only routes of this API that change anything: the three audited operator controls (see control/service.ts).
 * Token-protected like every /v1 route; the dashboard calls them from the server, after a confirmation dialog.
 */
function registerControl(app: FastifyInstance, control: ControlService, deps: AnalyticsDeps) {
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown) => {
    if (e instanceof ControlError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof z.ZodError)
      return reply.code(400).send({ error: e.issues[0]?.message ?? 'invalid' });
    throw e;
  };
  const collectorStatus = async () => {
    if (!deps.collectorUrl) return null;
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${deps.collectorUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  app.get('/v1/control', async () => ({
    collector: { ...(await control.collectorState()), live: await collectorStatus() },
    modes: await control.modes(),
  }));

  app.post('/v1/control/collector/:action', async (req, reply) => {
    try {
      const { action } = z.object({ action: z.enum(['pause', 'resume', 'run']) }).parse(req.params);
      if (action === 'run') {
        if (!deps.collectorUrl) return reply.code(404).send({ error: 'no collector configured' });
        const res = await (deps.fetchImpl ?? fetch)(`${deps.collectorUrl}/run`, {
          method: 'POST',
          headers: { authorization: `Bearer ${deps.apiToken}` },
          signal: AbortSignal.timeout(5000),
        });
        const body: unknown = await res.json().catch(() => ({}));
        return reply.code(res.status).send(body);
      }
      const a = actor.parse(req.body ?? {});
      return await control.setCollectorPaused(action === 'pause', a);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/v1/control/mode', async (req, reply) => {
    try {
      const b = actor
        .extend({ scope: z.string().min(3).max(300), mode: z.enum(['read_only', 'normal']) })
        .parse(req.body ?? {});
      return await control.setMode(b.scope, b.mode, b);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
