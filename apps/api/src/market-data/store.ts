import { desc, eq, marketPrices, type Database } from '@near-autopilot/db';
import { formatDecimal } from './decimal';
import type { MarketReport, MarketReportSink, PriceObservation } from './model';

const observationJson = (o: PriceObservation) => ({
  source: o.source,
  network: o.network,
  assetId: o.assetId,
  contract: o.contract,
  priceUsd: o.priceUsd ? formatDecimal(o.priceUsd) : null,
  quoteCurrency: o.quoteCurrency,
  confidence: o.confidence,
  publishedAt:
    o.publishedAt && !Number.isNaN(o.publishedAt.getTime()) ? o.publishedAt.toISOString() : null,
  fetchedAt: o.fetchedAt.toISOString(),
  ageMs: o.ageMs,
  status: o.status,
  reason: o.reason,
});

export type StoredMarketPrice = typeof marketPrices.$inferSelect;

/** Persists every report; reads back the latest one for the API. */
export class DrizzleMarketPriceStore implements MarketReportSink {
  constructor(private readonly db: Database) {}

  async record(report: MarketReport): Promise<void> {
    if (report.assets.length === 0) return;
    const sources = report.sources.map((s) => ({ ...s }));
    await this.db.insert(marketPrices).values(
      report.assets.map((a) => ({
        id: `${report.id}:${a.token}`,
        reportId: report.id,
        fetchedAt: report.fetchedAt,
        marketNetwork: report.marketNetwork,
        executionNetwork: report.executionNetwork,
        token: a.token,
        referenceSymbol: a.referenceSymbol,
        mainnetContract: a.mainnetContract,
        status: a.status,
        priceUsd: a.priceUsd ? formatDecimal(a.priceUsd) : null,
        source: a.chosen?.source ?? null,
        sourceAssetId: a.chosen?.assetId ?? null,
        publishedAt: a.chosen?.publishedAt ?? null,
        ageMs: a.chosen?.ageMs ?? null,
        spreadBps: a.spreadBps === null ? null : Number(a.spreadBps),
        reason: a.reason,
        observations: a.observations.map(observationJson),
        sources,
      })),
    );
  }

  /** Rows of the most recent report, or [] if none was ever stored. */
  async latest(): Promise<StoredMarketPrice[]> {
    const [last] = await this.db
      .select({ reportId: marketPrices.reportId })
      .from(marketPrices)
      .orderBy(desc(marketPrices.fetchedAt))
      .limit(1);
    if (!last) return [];
    return this.db.select().from(marketPrices).where(eq(marketPrices.reportId, last.reportId));
  }
}

export { observationJson };
