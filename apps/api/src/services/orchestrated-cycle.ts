import {
  describeIntent,
  errorMessage,
  toJsonSafe,
  type AccountId,
  type ExecutionMode,
  type ExecutionResult,
  type IdGenerator,
  type Logger,
  type Clock,
} from '@near-autopilot/core';
import {
  candidateToIntent,
  type AuditEntry,
  type AuditLog,
  type CycleReport,
  type EscalationEvent,
  type Notifier,
  type Orchestrator,
  type PolicyOutcomeSummary,
} from '@near-autopilot/orchestrator';
import type { AutopilotRepository, ProposalRecord } from '../repository';
import { CycleInProgressError, type CycleResult } from './cycle';

export interface OrchestratedCycleDeps {
  readonly accountId: AccountId;
  readonly executionMode: ExecutionMode;
  readonly orchestrator: Orchestrator;
  /** The orchestrator's audit log, read back for the per-agent outcome summary. */
  readonly audit: Pick<AuditLog, 'entries'>;
  readonly repo: AutopilotRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

/**
 * Runs one orchestrator cycle and records it in the same runs/proposals tables the legacy cycle uses, so the HTTP API
 * and dashboard are engine-agnostic. The orchestrator itself owns the decision, policy calls and execution; this class
 * only translates its report. (Dry-run only: the orchestrator's idempotency/audit stores are in-memory, see config.)
 */
export class OrchestratedCycle {
  private running = false;

  constructor(private readonly deps: OrchestratedCycleDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(): Promise<CycleResult> {
    if (this.running) throw new CycleInProgressError();
    this.running = true;
    const { repo, clock, ids, accountId, logger } = this.deps;
    const runId = ids.next();
    const startedAt = clock.now();
    await repo.createRun({ id: runId, accountId, startedAt });
    try {
      const report = await this.deps.orchestrator.runCycle(runId);
      const proposals = report.policy.map((summary) => this.toRecord(runId, report, summary));
      for (const p of proposals) await repo.insertProposal(p);
      const finishedAt = clock.now();
      const agents = agentOutcomes(await this.deps.audit.entries(), runId);
      const outcome = summarize(report, agents);
      await repo.finishRun(runId, {
        status: 'completed',
        finishedAt,
        error: null,
        outcome,
        snapshot: toJsonSafe({
          engine: 'orchestrator',
          cycleStatus: report.status,
          detail: report.detail,
          risk: report.decision?.risk ?? null,
          reasons: report.decision?.reasons ?? [],
          advisories: report.decision?.advisories ?? [],
          escalations: report.escalations,
          agents,
        }),
      });
      logger.info('orchestrator cycle finished', {
        runId,
        status: report.status,
        proposals: proposals.length,
      });
      return {
        run: {
          id: runId,
          accountId,
          status: 'completed',
          startedAt,
          finishedAt,
          error: null,
          outcome,
        },
        proposals,
      };
    } catch (error) {
      const finishedAt = clock.now();
      await repo.finishRun(runId, {
        status: 'failed',
        finishedAt,
        error: errorMessage(error),
        outcome: null,
        snapshot: null,
      });
      logger.error('orchestrator cycle failed', { runId, error: errorMessage(error) });
      return {
        run: {
          id: runId,
          accountId,
          status: 'failed',
          startedAt,
          finishedAt,
          error: errorMessage(error),
          outcome: null,
        },
        proposals: [],
      };
    } finally {
      this.running = false;
    }
  }

  /** One policy evaluation in the report -> one proposal row. */
  private toRecord(
    runId: string,
    report: CycleReport,
    summary: PolicyOutcomeSummary,
  ): ProposalRecord {
    const now = this.deps.clock.now();
    const decision = report.decision;
    const ranked = decision?.ranked ?? [];
    const rank = decision
      ? ranked.findIndex(
          (c, i) => candidateToIntent(c, decision.decisionId, i).id === summary.intentId,
        )
      : -1;
    const candidate = rank >= 0 ? ranked[rank] : undefined;
    const intent =
      decision && candidate ? candidateToIntent(candidate, decision.decisionId, rank) : null;
    const executed = summary.outcome === 'approve' ? report.execution : null;
    return {
      id: summary.intentId,
      runId,
      accountId: this.deps.accountId,
      agentId: intent?.agentId ?? `orchestrator/${candidate?.agent ?? 'unknown'}`,
      kind: intent?.kind ?? candidate?.action.kind ?? 'unknown',
      summary: intent ? describeIntent(intent) : summary.proposalId,
      reason: intent?.reason ?? '',
      intent: intent ? toJsonSafe(intent) : null,
      valueUsdMicro:
        candidate?.economics?.valueInUsdMicro ?? candidate?.riskEffect?.valueUsedUsdMicro ?? null,
      status: statusOf(summary, executed, report),
      violations: summary.violations,
      planHash: null,
      executionMode: executed ? executed.mode : null,
      txHash: executed?.txHash ?? null,
      error: executed?.error ?? (summary.outcome === 'approve' && !executed ? report.detail : null),
      createdAt: now,
      updatedAt: now,
    };
  }
}

/**
 * What each agent did this cycle, from the orchestrator's audit trail: its accepted output items (including
 * `no_action` with the reason code, e.g. `insufficient_data`), or that it errored, timed out or was skipped. Without
 * this an idle agent and a broken one look the same from outside.
 */
export function agentOutcomes(
  entries: readonly AuditEntry[],
  cycleKey: string,
): Array<Record<string, unknown>> {
  const outcomes: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    if (e.cycleKey !== cycleKey || !e.type.startsWith('agent.')) continue;
    const { agent, ...rest } = e.payload;
    outcomes.push({ agent, event: e.type.slice('agent.'.length), ...rest });
  }
  return outcomes;
}

/**
 * "no action: DATA_NOT_FRESH; escalations: RISK_WATCH; market-intelligence: insufficient_data (no market data
 * available); liquidation-guardian: 2 proposal(s)". Bounded: this goes into a table cell.
 */
export function summarize(
  report: CycleReport,
  agents: ReadonlyArray<Record<string, unknown>>,
): string {
  const parts = [report.detail];
  if (report.escalations.length > 0) {
    parts.push(`escalations: ${[...new Set(report.escalations.map((e) => e.code))].join(', ')}`);
  }
  for (const a of agents) {
    const name = typeof a['agent'] === 'string' ? a['agent'] : 'agent';
    const event = typeof a['event'] === 'string' ? a['event'] : '';
    const items: unknown[] = Array.isArray(a['proposals']) ? a['proposals'] : [];
    const noAction = items.find(
      (p): p is { reasonCode: string; rationale?: unknown } =>
        typeof p === 'object' &&
        p !== null &&
        'reasonCode' in p &&
        typeof p.reasonCode === 'string',
    );
    if (event !== 'output') parts.push(`${name}: ${event}`);
    else if (noAction) {
      const why = typeof noAction.rationale === 'string' ? ` (${noAction.rationale})` : '';
      parts.push(`${name}: ${noAction.reasonCode}${why}`);
    } else parts.push(`${name}: ${items.length} proposal(s)`);
  }
  const text = parts.join('; ');
  return text.length > 1000 ? `${text.slice(0, 999)}…` : text;
}

function statusOf(
  summary: PolicyOutcomeSummary,
  executed: ExecutionResult | null,
  report: CycleReport,
): ProposalRecord['status'] {
  if (summary.outcome === 'reject') return 'rejected';
  if (summary.outcome === 'require_approval') return 'requires_approval';
  if (!executed) return report.status === 'dry_run' ? 'dry_run' : 'failed';
  if (executed.status === 'success') return 'executed';
  if (executed.status === 'dry_run') return 'dry_run';
  return 'failed';
}

/** Escalations go to the structured log and the audit table (there is no pager integration yet). */
export class RepositoryNotifier implements Notifier {
  constructor(
    private readonly repo: AutopilotRepository,
    private readonly logger: Logger,
  ) {}

  async notify(event: EscalationEvent): Promise<void> {
    const fields = { severity: event.severity, message: event.message };
    if (event.severity === 'info') this.logger.info(`escalation ${event.code}`, fields);
    else this.logger.warn(`escalation ${event.code}`, fields);
    await this.repo.appendAudit({
      at: event.at,
      type: `escalation_${event.severity}`,
      runId: event.cycleKey,
      proposalId: null,
      payload: toJsonSafe(event),
    });
  }
}
