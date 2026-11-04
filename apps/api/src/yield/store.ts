import { and, desc, eq, lte, yieldObservations, type Database } from '@near-autopilot/db';
import { formatDecimal } from '../market-data/decimal';
import type {
  PoolHistory,
  PoolObservation,
  YieldReport,
  YieldReportSink,
  YieldSourceName,
} from './model';

export type StoredYieldObservation = typeof yieldObservations.$inferSelect;

/** Persists every yield estimate (valid, rejected, informational) and serves earlier pool observations. */
export class DrizzleYieldStore implements YieldReportSink, PoolHistory {
  constructor(private readonly db: Database) {}

  async record(report: YieldReport): Promise<void> {
    if (report.estimates.length === 0) return;
    const sources = report.sources.map((s) => ({ ...s }));
    await this.db.insert(yieldObservations).values(
      report.estimates.map((e, i) => ({
        id: `${report.id}:${i}`,
        reportId: report.id,
        observedAt: report.observedAt,
        network: e.network,
        blockHeight: e.block.height,
        blockTimestamp: e.block.timestamp,
        source: e.source,
        contract: e.contract,
        methods: [...e.methods],
        marketId: e.marketId,
        assetIds: [...e.assetIds],
        yieldType: e.yieldType,
        apr: e.apr ? formatDecimal(e.apr) : null,
        apy: e.apy ? formatDecimal(e.apy) : null,
        calculationMethod: e.calculationMethod,
        formula: e.formula,
        observationPeriodSeconds: e.observationPeriodSeconds,
        utilization: e.utilization ? formatDecimal(e.utilization) : null,
        liquidityUsd: e.liquidityUsd ? formatDecimal(e.liquidityUsd) : null,
        volumeUsd: e.volumeUsd ? formatDecimal(e.volumeUsd) : null,
        priceStatus: e.priceStatus,
        sourceTimestamp: e.sourceTimestamp,
        validationStatus: e.validationStatus,
        reasons: e.reasons.map((r) => ({ ...r })),
        raw: { ...e.raw },
        sources,
        origin: report.origin,
      })),
    );
  }

  async previous(
    source: YieldSourceName,
    marketId: string,
    before: Date,
    minAgeSeconds: number,
  ): Promise<PoolObservation | null> {
    const cutoff = new Date(before.getTime() - minAgeSeconds * 1000);
    const [row] = await this.db
      .select({
        blockTimestamp: yieldObservations.blockTimestamp,
        blockHeight: yieldObservations.blockHeight,
        raw: yieldObservations.raw,
        reasons: yieldObservations.reasons,
      })
      .from(yieldObservations)
      .where(
        and(
          eq(yieldObservations.source, source),
          eq(yieldObservations.marketId, marketId),
          lte(yieldObservations.blockTimestamp, cutoff),
        ),
      )
      .orderBy(desc(yieldObservations.blockTimestamp))
      .limit(1);
    if (!row || typeof row.raw !== 'object' || row.raw === null) return null;
    return {
      observedAt: row.blockTimestamp,
      blockHeight: row.blockHeight,
      raw: row.raw as Record<string, unknown>,
      reasonCodes: Array.isArray(row.reasons)
        ? (row.reasons as unknown[]).flatMap((r) =>
            r && typeof r === 'object' && typeof (r as { code?: unknown }).code === 'string'
              ? [(r as { code: string }).code]
              : [],
          )
        : [],
    };
  }

  /** Rows of the most recent report, or [] if none was ever stored. */
  async latest(): Promise<StoredYieldObservation[]> {
    const [last] = await this.db
      .select({ reportId: yieldObservations.reportId })
      .from(yieldObservations)
      .orderBy(desc(yieldObservations.observedAt))
      .limit(1);
    if (!last) return [];
    return this.db
      .select()
      .from(yieldObservations)
      .where(eq(yieldObservations.reportId, last.reportId));
  }
}
