import type { Provenance } from '@near-autopilot/core';
import type { PolicyHistory } from '@near-autopilot/policy-engine';
import type {
  AuditEvent,
  AutopilotRepository,
  PolicyVerdictRecord,
  ProposalPatch,
  ProposalRecord,
  RunRecord,
} from '../src/repository';

/** Test-only AutopilotRepository. Mirrors the semantics the Drizzle implementation guarantees. */
export class InMemoryRepository implements AutopilotRepository {
  constructor(readonly provenance: Provenance = { dataSource: 'chain', network: 'mainnet' }) {}

  readonly runs = new Map<string, RunRecord>();
  readonly proposals = new Map<string, ProposalRecord>();
  readonly audit: AuditEvent[] = [];
  readonly verdicts: PolicyVerdictRecord[] = [];
  readonly snapshots = new Map<string, unknown>();
  /** Test hook to simulate prior live executions. */
  executionHistory: PolicyHistory = { spentLast24hUsdMicro: 0n, lastExecutedAt: null };
  /** Order of operations, to assert persist-before-execute. */
  readonly log: string[] = [];

  async createRun(run: Pick<RunRecord, 'id' | 'accountId' | 'startedAt'>): Promise<void> {
    this.runs.set(run.id, {
      ...run,
      status: 'running',
      finishedAt: null,
      error: null,
      outcome: null,
    });
  }
  async finishRun(
    id: string,
    update: {
      status: 'completed' | 'failed';
      finishedAt: Date;
      error: string | null;
      outcome: string | null;
      snapshot: unknown;
    },
  ): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`unknown run ${id}`);
    this.runs.set(id, {
      ...run,
      status: update.status,
      finishedAt: update.finishedAt,
      error: update.error,
      outcome: update.outcome,
    });
    this.snapshots.set(id, update.snapshot);
  }
  async insertProposal(p: ProposalRecord): Promise<void> {
    this.log.push(`insert:${p.status}`);
    this.proposals.set(p.id, p);
  }
  async updateProposal(id: string, patch: ProposalPatch): Promise<void> {
    const current = this.proposals.get(id);
    if (!current) throw new Error(`unknown proposal ${id}`);
    this.log.push(`update:${patch.status ?? ''}`);
    this.proposals.set(id, { ...current, ...patch });
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    this.audit.push(event);
  }
  async insertPolicyVerdict(v: PolicyVerdictRecord): Promise<void> {
    this.log.push(`verdict:${v.verdict}`);
    this.verdicts.push(v);
  }
  async listPolicyVerdicts(options: {
    limit: number;
    verdict?: PolicyVerdictRecord['verdict'];
  }): Promise<Array<PolicyVerdictRecord & Provenance>> {
    return [...this.verdicts]
      .reverse()
      .filter((v) => options.verdict === undefined || v.verdict === options.verdict)
      .slice(0, options.limit)
      .map((v) => ({ ...v, ...this.provenance }));
  }
  async getExecutionStats(): Promise<PolicyHistory> {
    return this.executionHistory;
  }
  async listRuns(
    limit: number,
  ): Promise<Array<RunRecord & Provenance & { proposalCount: number }>> {
    return [...this.runs.values()].slice(0, limit).map((r) => ({
      ...r,
      ...this.provenance,
      proposalCount: [...this.proposals.values()].filter((p) => p.runId === r.id).length,
    }));
  }
  async listProposals(options: {
    limit: number;
    runId?: string;
  }): Promise<Array<ProposalRecord & Provenance>> {
    return [...this.proposals.values()]
      .filter((p) => options.runId === undefined || p.runId === options.runId)
      .slice(0, options.limit)
      .map((p) => ({ ...p, ...this.provenance }));
  }
  async ping(): Promise<void> {}
}
