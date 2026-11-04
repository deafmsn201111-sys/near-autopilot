import type { ExecutionMode, PolicyViolation, ProposalStatus } from '@near-autopilot/core';
import type { PolicyHistory } from '@near-autopilot/policy-engine';

export interface RunRecord {
  readonly id: string;
  readonly accountId: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly error: string | null;
}

export interface ProposalRecord {
  readonly id: string;
  readonly runId: string;
  readonly accountId: string;
  readonly agentId: string;
  readonly kind: string;
  readonly summary: string;
  readonly reason: string;
  /** JSON-safe intent. */
  readonly intent: unknown;
  readonly valueUsdMicro: bigint | null;
  readonly status: ProposalStatus;
  readonly violations: readonly PolicyViolation[];
  readonly planHash: string | null;
  readonly executionMode: ExecutionMode | null;
  readonly txHash: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ProposalPatch = Partial<
  Pick<
    ProposalRecord,
    'status' | 'violations' | 'valueUsdMicro' | 'planHash' | 'executionMode' | 'txHash' | 'error'
  >
> & { readonly updatedAt: Date };

export interface AuditEvent {
  readonly at: Date;
  readonly type: string;
  readonly runId: string | null;
  readonly proposalId: string | null;
  readonly payload: unknown;
}

/** Persistence port used by the cycle and the HTTP layer. Implemented with Drizzle in `infra/`. */
export interface AutopilotRepository {
  createRun(run: Pick<RunRecord, 'id' | 'accountId' | 'startedAt'>): Promise<void>;
  finishRun(
    id: string,
    update: {
      status: 'completed' | 'failed';
      finishedAt: Date;
      error: string | null;
      snapshot: unknown;
    },
  ): Promise<void>;
  insertProposal(proposal: ProposalRecord): Promise<void>;
  updateProposal(id: string, patch: ProposalPatch): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  /** Live, executed proposals only: spend since `since` and the most recent execution time. */
  getExecutionStats(accountId: string, since: Date): Promise<PolicyHistory>;
  listRuns(limit: number): Promise<Array<RunRecord & { proposalCount: number }>>;
  listProposals(options: { limit: number; runId?: string }): Promise<ProposalRecord[]>;
  ping(): Promise<void>;
}
