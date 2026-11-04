import type { AutopilotRepository } from '../repository';
import type { PoolHistory, YieldReport, YieldReportSink } from './model';

/**
 * Persists each yield report and records one `yield.report` audit event for it: the block, every source's health,
 * how many estimates were valid / rejected / informational, and per estimate the rejection codes. The orchestrator's
 * decision records `marketProvenance.yieldReportId`, which links a decision to this event and its rows.
 */
export class AuditedYieldSink implements YieldReportSink, PoolHistory {
  constructor(
    private readonly store: YieldReportSink & PoolHistory,
    private readonly repo: Pick<AutopilotRepository, 'appendAudit'>,
  ) {}

  async record(report: YieldReport): Promise<void> {
    await this.store.record(report);
    const count = (s: string) => report.estimates.filter((e) => e.validationStatus === s).length;
    await this.repo.appendAudit({
      at: report.observedAt,
      type: 'yield.report',
      runId: null,
      proposalId: null,
      payload: {
        reportId: report.id,
        network: report.network,
        blockHeight: report.block?.height ?? null,
        sources: report.sources.map((s) => ({ ...s })),
        counts: {
          valid: count('valid'),
          rejected: count('rejected'),
          informational: count('informational'),
        },
        estimates: report.estimates.map((e) => ({
          source: e.source,
          marketId: e.marketId,
          yieldType: e.yieldType,
          validationStatus: e.validationStatus,
          codes: e.reasons.map((r) => r.code),
        })),
      },
    });
  }

  previous(...args: Parameters<PoolHistory['previous']>): ReturnType<PoolHistory['previous']> {
    return this.store.previous(...args);
  }
}
