import {
  and,
  asc,
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
  portfolioAnalyses,
  priceObservations,
  rheaPoolObservations,
  rheaPools,
  sql,
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

  async trackedPools(): Promise<PoolRow[]> {
    return this.db
      .select()
      .from(rheaPools)
      .where(
        and(
          eq(rheaPools.active, true),
          inArray(rheaPools.category, [
            'LIQUID',
            'ANALYTICS_ELIGIBLE',
            'LP_SIMULATION_ELIGIBLE',
            'UNSUPPORTED',
          ]),
        ),
      );
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
