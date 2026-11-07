import {
  and,
  asc,
  auditEvents,
  burrowMarketObservations,
  burrowMarkets,
  collectorCycles,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  marketSnapshots,
  ne,
  or,
  policyVerdicts,
  portfolioAnalyses,
  priceObservations,
  rheaPoolObservations,
  rheaPools,
  sql,
  tokenMetadata,
  type Database,
} from '@near-autopilot/db';
import { formatDecimal } from '../market-data/decimal';
import type { PriceObservation } from '../market-data/model';
import type { PoolPoint } from './history';
import type { SourceRun } from './model';

const CHUNK = 500;
const chunks = <T>(xs: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
};

export type CycleRow = typeof collectorCycles.$inferSelect;
export type PoolRow = typeof rheaPools.$inferSelect;
export type NewPoolRow = typeof rheaPools.$inferInsert;
export type PoolObservationRow = typeof rheaPoolObservations.$inferInsert;
export type BurrowObservationRow = typeof burrowMarketObservations.$inferInsert;

/** Collector persistence. Writes are additive (insert / upsert of the registry); nothing is ever deleted. */
export class CollectorStore {
  constructor(readonly db: Database) {}

  /**
   * Claims the single `running` slot (partial unique index): false if another cycle is running anywhere, so cycles
   * never overlap across processes.
   */
  async startCycle(
    id: string,
    trigger: 'scheduled' | 'on_demand',
    at: Date,
    registryScan: boolean,
  ): Promise<boolean> {
    const r = await this.db
      .insert(collectorCycles)
      .values({ id, trigger, status: 'running', startedAt: at, sources: [], registryScan })
      .onConflictDoNothing()
      .returning({ id: collectorCycles.id });
    return r.length === 1;
  }

  async finishCycle(
    id: string,
    v: {
      status: 'success' | 'partial' | 'failed';
      finishedAt: Date;
      durationMs: number;
      records: number;
      sources: readonly SourceRun[];
      error: string | null;
      snapshotId: string | null;
    },
  ) {
    await this.db
      .update(collectorCycles)
      .set({ ...v, sources: v.sources.map((s) => ({ ...s })) })
      .where(eq(collectorCycles.id, id));
  }

  /** Cycles left `running` by a crash are closed as failed on start-up (they never finished). */
  async closeAbandoned(at: Date) {
    await this.db
      .update(collectorCycles)
      .set({
        status: 'failed',
        finishedAt: at,
        error: 'collector stopped before the cycle finished',
      })
      .where(eq(collectorCycles.status, 'running'));
  }

  /** Completed cycles since the last completed registry scan, and when that scan started. */
  /** The cycle's registry scan failed: it does not count as a scan. */
  async markNotScanned(cycleId: string): Promise<void> {
    await this.db
      .update(collectorCycles)
      .set({ registryScan: false })
      .where(eq(collectorCycles.id, cycleId));
  }

  async registryScanState(): Promise<{ cycles: number; lastAt: Date } | null> {
    const [last] = await this.db
      .select({ at: collectorCycles.startedAt })
      .from(collectorCycles)
      .where(
        and(
          eq(collectorCycles.registryScan, true),
          inArray(collectorCycles.status, ['success', 'partial']),
        ),
      )
      .orderBy(desc(collectorCycles.startedAt))
      .limit(1);
    if (!last) return null;
    const r = await this.db.execute<{ n: number }>(
      sql`select count(*)::int as n from collector_cycles where started_at > ${last.at} and status in ('success','partial')`,
    );
    return { cycles: r.rows[0]?.n ?? 0, lastAt: last.at };
  }

  async insertSnapshot(row: typeof marketSnapshots.$inferInsert) {
    await this.db.insert(marketSnapshots).values(row);
  }

  async insertPrices(
    snapshotId: string,
    observations: readonly (PriceObservation & { asset: string })[],
  ) {
    for (const part of chunks(observations))
      await this.db.insert(priceObservations).values(
        part.map((o, i) => ({
          id: `${snapshotId}:${o.source}:${o.asset}:${i}`,
          snapshotId,
          asset: o.asset,
          source: o.source,
          sourceAssetId: o.assetId,
          priceUsd: o.priceUsd ? formatDecimal(o.priceUsd) : null,
          quoteCurrency: o.quoteCurrency,
          confidence: o.confidence,
          publishedAt:
            o.publishedAt && !Number.isNaN(o.publishedAt.getTime()) ? o.publishedAt : null,
          observedAt: o.fetchedAt,
          ageMs:
            o.ageMs === null
              ? null
              : Math.max(-2_000_000_000, Math.min(2_000_000_000, Math.round(o.ageMs))),
          status: o.status,
          reason: o.reason,
        })),
      );
  }

  async upsertPools(rows: readonly NewPoolRow[]) {
    for (const part of chunks(rows))
      await this.db
        .insert(rheaPools)
        .values(part)
        .onConflictDoUpdate({
          target: rheaPools.poolKey,
          set: {
            poolType: sql`excluded.pool_type`,
            tokens: sql`excluded.tokens`,
            lastSeenAt: sql`excluded.last_seen_at`,
            lastBlockHeight: sql`excluded.last_block_height`,
            feeBps: sql`excluded.fee_bps`,
            tvlUsd: sql`excluded.tvl_usd`,
            priceQuality: sql`excluded.price_quality`,
            category: sql`excluded.category`,
            modelStatus: sql`excluded.model_status`,
            reasons: sql`excluded.reasons`,
            active: sql`excluded.active`,
            latest: sql`excluded.latest`,
          },
        });
  }

  /** Pools seen before but missing from a full scan are marked inactive (kept, never deleted). */
  async markMissingInactive(family: 'v1' | 'dcl', seen: readonly string[], at: Date) {
    const all = await this.db
      .select({ k: rheaPools.poolKey })
      .from(rheaPools)
      .where(eq(rheaPools.family, family));
    const present = new Set(seen);
    const gone = all.map((r) => r.k).filter((k) => !present.has(k));
    for (const part of chunks(gone))
      await this.db
        .update(rheaPools)
        .set({ active: false, category: 'DATA_INVALID', lastSeenAt: at })
        .where(inArray(rheaPools.poolKey, part));
    return gone.length;
  }

  /**
   * Pools re-read every cycle: active pools in a tracked category, AND active pools demoted only because a price was
   * missing (price_quality UNPRICED) that had a PRICED observation in the last 24 h. Without the second part, one
   * transient price gap dropped a pool from tracking for good (it was never re-read, so it could never be re-priced)
   * and the next registry scan treated it as new. The criteria are not relaxed: every cycle still classifies it.
   */
  async trackedPools(now: Date = new Date()): Promise<PoolRow[]> {
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const recentlyPriced = this.db
      .selectDistinct({ poolKey: rheaPoolObservations.poolKey })
      .from(rheaPoolObservations)
      .where(
        and(
          gte(rheaPoolObservations.blockTimestamp, since),
          isNotNull(rheaPoolObservations.volumesIn),
          ne(rheaPoolObservations.priceQuality, 'UNPRICED'),
        ),
      );
    return this.db
      .select()
      .from(rheaPools)
      .where(
        and(
          eq(rheaPools.active, true),
          or(
            inArray(rheaPools.category, [
              'LIQUID',
              'ANALYTICS_ELIGIBLE',
              'LP_SIMULATION_ELIGIBLE',
              'UNSUPPORTED',
            ]),
            and(eq(rheaPools.priceQuality, 'UNPRICED'), inArray(rheaPools.poolKey, recentlyPriced)),
          ),
        ),
      );
  }

  /** Pools with stored fee history (any observation with cumulative volumes), whatever their category now. */
  async poolsWithHistory(): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ poolKey: rheaPoolObservations.poolKey })
      .from(rheaPoolObservations)
      .where(isNotNull(rheaPoolObservations.volumesIn));
    return new Set(rows.map((r) => r.poolKey));
  }

  async backfillTargets(): Promise<PoolRow[]> {
    return this.db
      .select()
      .from(rheaPools)
      .where(
        and(
          eq(rheaPools.active, true),
          eq(rheaPools.family, 'v1'),
          eq(rheaPools.modelStatus, 'SUPPORTED'),
          inArray(rheaPools.category, ['LIQUID', 'ANALYTICS_ELIGIBLE', 'LP_SIMULATION_ELIGIBLE']),
        ),
      );
  }

  /** Timestamps of every stored point of one pool (backfill skips targets that already have a point nearby). */
  async pointTimes(poolKey: string): Promise<Date[]> {
    const rows = await this.db
      .select({ at: rheaPoolObservations.blockTimestamp })
      .from(rheaPoolObservations)
      .where(eq(rheaPoolObservations.poolKey, poolKey));
    return rows.map((r) => r.at);
  }

  /**
   * Latest stored point. With `withVolumes`, the latest point that carries cumulative volumes: a registry-scan
   * reading has none, so it can neither start a fee window nor serve as the base of a volume regression check.
   */
  async lastPoolPoint(poolKey: string, withVolumes = false): Promise<PoolPoint | null> {
    const [r] = await this.db
      .select()
      .from(rheaPoolObservations)
      .where(
        withVolumes
          ? and(
              eq(rheaPoolObservations.poolKey, poolKey),
              isNotNull(rheaPoolObservations.volumesIn),
            )
          : eq(rheaPoolObservations.poolKey, poolKey),
      )
      .orderBy(desc(rheaPoolObservations.blockHeight))
      .limit(1);
    return r ? toPoint(r) : null;
  }

  async insertPoolObservations(rows: readonly PoolObservationRow[]) {
    for (const part of chunks(rows))
      await this.db.insert(rheaPoolObservations).values(part).onConflictDoNothing();
  }

  /**
   * Fee-window start: the latest point at or before `before`, or the first point when `before` is null. Only points
   * with cumulative volumes qualify (a window needs volumes at both ends); a registry-scan reading without them is
   * skipped, never used as "the start of history".
   */
  async poolPointAtOrBefore(poolKey: string, before: Date | null): Promise<PoolPoint | null> {
    const pool = and(
      eq(rheaPoolObservations.poolKey, poolKey),
      isNotNull(rheaPoolObservations.volumesIn),
    );
    const [r] = await this.db
      .select()
      .from(rheaPoolObservations)
      .where(before ? and(pool, lte(rheaPoolObservations.blockTimestamp, before)) : pool)
      .orderBy(
        before
          ? desc(rheaPoolObservations.blockTimestamp)
          : asc(rheaPoolObservations.blockTimestamp),
      )
      .limit(1);
    return r ? toPoint(r) : null;
  }

  /** Over (start, end]: whether any observation failed the sequence check, and the raw price ratio range. */
  async windowStats(poolKey: string, start: Date, end: Date) {
    const r = await this.db.execute<{
      broken: number;
      mn: string | null;
      mx: string | null;
      n: number;
    }>(sql`
      select count(*) filter (where quality = 'DATA_INVALID')::int as broken,
             min((reserves->>1)::numeric / nullif((reserves->>0)::numeric, 0))::text as mn,
             max((reserves->>1)::numeric / nullif((reserves->>0)::numeric, 0))::text as mx,
             count(*)::int as n
      from rhea_pool_observations
      where pool_key = ${poolKey} and block_timestamp >= ${start} and block_timestamp <= ${end}`);
    const row = r.rows[0];
    return {
      broken: (row?.broken ?? 0) > 0,
      range:
        row?.mn && row.mx ? { min: Number(row.mn), max: Number(row.mx), samples: row.n } : null,
    };
  }

  async upsertBurrowMarkets(rows: readonly (typeof burrowMarkets.$inferInsert)[]) {
    for (const part of chunks(rows))
      await this.db
        .insert(burrowMarkets)
        .values(part)
        .onConflictDoUpdate({
          target: burrowMarkets.token,
          set: {
            lastSeenAt: sql`excluded.last_seen_at`,
            status: sql`excluded.status`,
            latest: sql`excluded.latest`,
          },
        });
  }

  async insertBurrowObservations(rows: readonly BurrowObservationRow[]) {
    for (const part of chunks(rows))
      await this.db.insert(burrowMarketObservations).values(part).onConflictDoNothing();
  }

  async insertAnalysis(row: typeof portfolioAnalyses.$inferInsert) {
    await this.db.insert(portfolioAnalyses).values(row).onConflictDoNothing();
  }

  /* ------------------------------ reads for the analytics API ------------------------------ */

  async recentCycles(limit: number): Promise<CycleRow[]> {
    return this.db
      .select()
      .from(collectorCycles)
      .orderBy(desc(collectorCycles.startedAt))
      .limit(limit);
  }

  async latestSnapshot() {
    const [s] = await this.db
      .select()
      .from(marketSnapshots)
      .orderBy(desc(marketSnapshots.takenAt))
      .limit(1);
    return s ?? null;
  }

  /** Every stored token's symbol and decimals (display only). */
  async tokenMetadata() {
    return this.db.select().from(tokenMetadata);
  }

  /** Insert or refresh token metadata (a contract may change its own metadata; the latest read wins). */
  async upsertTokenMetadata(rows: readonly (typeof tokenMetadata.$inferInsert)[]) {
    for (let i = 0; i < rows.length; i += 200)
      await this.db
        .insert(tokenMetadata)
        .values(rows.slice(i, i + 200))
        .onConflictDoUpdate({
          target: tokenMetadata.token,
          set: {
            symbol: sql`excluded.symbol`,
            decimals: sql`excluded.decimals`,
            blockHeight: sql`excluded.block_height`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
  }

  /** Tokens the dashboards show: every Burrow market, every priced token, and the tokens of the `limit` largest pools. */
  async displayTokens(limit: number): Promise<string[]> {
    const pools = await this.db
      .select({ tokens: rheaPools.tokens })
      .from(rheaPools)
      .orderBy(sql`${rheaPools.tvlUsd}::numeric desc nulls last`)
      .limit(limit);
    const markets = await this.db.select({ token: burrowMarkets.token }).from(burrowMarkets);
    const snapshot = await this.latestSnapshot();
    const priced = snapshot
      ? await this.db
          .selectDistinct({ asset: priceObservations.asset })
          .from(priceObservations)
          .where(eq(priceObservations.snapshotId, snapshot.id))
      : [];
    return [
      ...new Set([
        ...pools.flatMap((p) => p.tokens),
        ...markets.map((m) => m.token),
        ...priced.map((p) => p.asset),
      ]),
    ];
  }

  async pools() {
    return this.db.select().from(rheaPools);
  }

  async pool(poolKey: string) {
    const [p] = await this.db
      .select()
      .from(rheaPools)
      .where(eq(rheaPools.poolKey, poolKey))
      .limit(1);
    return p ?? null;
  }

  async poolHistory(poolKey: string, since: Date) {
    return this.db
      .select()
      .from(rheaPoolObservations)
      .where(
        and(
          eq(rheaPoolObservations.poolKey, poolKey),
          gte(rheaPoolObservations.blockTimestamp, since),
        ),
      )
      .orderBy(asc(rheaPoolObservations.blockTimestamp));
  }

  async markets() {
    return this.db.select().from(burrowMarkets);
  }

  async marketHistory(token: string, since: Date) {
    return this.db
      .select()
      .from(burrowMarketObservations)
      .where(
        and(
          eq(burrowMarketObservations.token, token),
          gte(burrowMarketObservations.blockTimestamp, since),
        ),
      )
      .orderBy(asc(burrowMarketObservations.blockTimestamp));
  }

  async pricesForSnapshot(snapshotId: string) {
    return this.db
      .select()
      .from(priceObservations)
      .where(eq(priceObservations.snapshotId, snapshotId));
  }

  async priceHistory(asset: string, since: Date) {
    return this.db
      .select()
      .from(priceObservations)
      .where(and(eq(priceObservations.asset, asset), gte(priceObservations.observedAt, since)))
      .orderBy(asc(priceObservations.observedAt));
  }

  /** Every price observation since `since`, slim columns only (charts and sparklines). */
  async priceSeries(since: Date) {
    return this.db
      .select({
        snapshotId: priceObservations.snapshotId,
        asset: priceObservations.asset,
        source: priceObservations.source,
        priceUsd: priceObservations.priceUsd,
        quoteCurrency: priceObservations.quoteCurrency,
        status: priceObservations.status,
        observedAt: priceObservations.observedAt,
      })
      .from(priceObservations)
      .where(gte(priceObservations.observedAt, since))
      .orderBy(asc(priceObservations.observedAt));
  }

  async poolTvlSeries(since: Date) {
    return this.db
      .select({
        poolKey: rheaPoolObservations.poolKey,
        at: rheaPoolObservations.blockTimestamp,
        tvlUsd: rheaPoolObservations.tvlUsd,
      })
      .from(rheaPoolObservations)
      .where(gte(rheaPoolObservations.blockTimestamp, since))
      .orderBy(asc(rheaPoolObservations.blockTimestamp));
  }

  async marketSeries(since: Date) {
    return this.db
      .select({
        token: burrowMarketObservations.token,
        at: burrowMarketObservations.blockTimestamp,
        supplyApr: burrowMarketObservations.supplyApr,
        borrowApr: burrowMarketObservations.borrowApr,
        utilization: burrowMarketObservations.utilization,
      })
      .from(burrowMarketObservations)
      .where(gte(burrowMarketObservations.blockTimestamp, since))
      .orderBy(asc(burrowMarketObservations.blockTimestamp));
  }

  /** The decision engine's risk block of every demo-portfolio analysis since `since` (not the whole result). */
  async riskSeries(since: Date) {
    return this.db
      .select({
        portfolioId: portfolioAnalyses.portfolioId,
        at: portfolioAnalyses.createdAt,
        risk: sql<unknown>`${portfolioAnalyses.result}->'decision'->'risk'`,
        description: sql<string | null>`${portfolioAnalyses.result}->'portfolio'->>'description'`,
      })
      .from(portfolioAnalyses)
      .where(gte(portfolioAnalyses.createdAt, since))
      .orderBy(asc(portfolioAnalyses.createdAt));
  }

  /** The newest analyses of one demo portfolio (newest first). */
  async analysesOf(portfolioId: string, limit: number) {
    return this.db
      .select()
      .from(portfolioAnalyses)
      .where(eq(portfolioAnalyses.portfolioId, portfolioId))
      .orderBy(desc(portfolioAnalyses.createdAt))
      .limit(limit);
  }

  /** Dashboard requests ("let the agent do it") for one demo portfolio, newest first. */
  async requestEvents(portfolio: string, limit: number) {
    return this.db
      .select({
        at: auditEvents.at,
        type: auditEvents.type,
        runId: auditEvents.runId,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          inArray(auditEvents.type, [
            'operator.request',
            'operator.request.result',
            'operator.request.failed',
          ]),
          sql`${auditEvents.payload}->>'portfolio' = ${portfolio}`,
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(limit);
  }

  /** Policy verdicts recorded in these runs (an analysis's run id), oldest first. */
  async verdictsOfRuns(runIds: readonly string[]) {
    if (runIds.length === 0) return [];
    return this.db
      .select({
        runId: policyVerdicts.runId,
        verdict: policyVerdicts.verdict,
        intentKind: policyVerdicts.intentKind,
        violations: policyVerdicts.violations,
        evaluatedAt: policyVerdicts.evaluatedAt,
        id: policyVerdicts.id,
      })
      .from(policyVerdicts)
      .where(inArray(policyVerdicts.runId, [...runIds]))
      .orderBy(asc(policyVerdicts.evaluatedAt));
  }

  async analysesForSnapshot(snapshotId: string) {
    return this.db
      .select()
      .from(portfolioAnalyses)
      .where(eq(portfolioAnalyses.snapshotId, snapshotId));
  }
}

function toPoint(r: typeof rheaPoolObservations.$inferSelect): PoolPoint {
  return {
    blockHeight: r.blockHeight,
    at: r.blockTimestamp,
    reserves: r.reserves,
    volumesIn: r.volumesIn ?? null,
    feeBps: r.feeBps,
    adminFeeBps: r.adminFeeBps,
    tvlUsd: r.tvlUsd,
  };
}
