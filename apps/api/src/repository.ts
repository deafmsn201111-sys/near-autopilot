import type {
  ExecutionMode,
  PolicyCheck,
  PolicyDecision,
  PolicyVerdict,
  PolicyViolation,
  ProposalStatus,
  Provenance,
} from '@near-autopilot/core';
import type { PolicyHistory } from '@near-autopilot/policy-engine';

export interface RunRecord {
  readonly id: string;
  readonly accountId: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly error: string | null;
  /** Human-readable summary of what the cycle saw and decided (why nothing happened, too). */
  readonly outcome: string | null;
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

/** One persisted policy decision (table policy_verdicts). `input` is the canonical, JSON-safe evaluation input. */
export interface PolicyVerdictRecord {
  readonly id: string;
  readonly evaluatedAt: Date;
  readonly engine: 'legacy' | 'orchestrator';
  readonly runId: string | null;
  readonly intentId: string;
  readonly intentKind: string;
  readonly verdict: PolicyVerdict;
  readonly outcome: PolicyDecision['outcome'];
  readonly policyVersion: string;
  readonly snapshotId: string;
  readonly planHash: string;
  readonly valueUsdMicro: bigint | null;
  readonly checks: readonly PolicyCheck[];
  readonly violations: readonly PolicyViolation[];
  readonly input: unknown;
}

/**
 * One Shadow Gateway routing record (table execution_routes): the venues quoted for an approved plan (origin
 * `gateway`) or for a reference trade (origin `probe`), the venue chosen and why. Nothing here was ever executed.
 */
export interface ExecutionRouteRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly origin: 'gateway' | 'probe';
  /** gateway: routed (a venue chosen) / no_route / not_a_swap / refused (no stored ALLOW, or the approval failed). */
  readonly outcome: 'routed' | 'no_route' | 'not_a_swap' | 'refused';
  readonly decisionId: string | null;
  readonly intentId: string | null;
  readonly planHash: string | null;
  readonly tokenIn: string | null;
  readonly tokenOut: string | null;
  readonly amountIn: bigint | null;
  readonly chosenVenue: string | null;
  readonly advantageBps: number | null;
  readonly reason: string;
  /** Every venue's quote and score, JSON-safe. */
  readonly quotes: unknown;
}

export interface AuditEvent {
  readonly at: Date;
  readonly type: string;
  readonly runId: string | null;
  readonly proposalId: string | null;
  readonly payload: unknown;
}

/**
 * Persistence port used by the cycle and the HTTP layer. Implemented with Drizzle in `infra/`.
 * An implementation is bound to ONE deployment provenance (data source + network) and stamps it on every run and
 * proposal it writes; reads return what was stored, so rows from different deployments sharing a database keep
 * their own labels.
 */
export interface AutopilotRepository {
  createRun(run: Pick<RunRecord, 'id' | 'accountId' | 'startedAt'>): Promise<void>;
  finishRun(
    id: string,
    update: {
      status: 'completed' | 'failed';
      finishedAt: Date;
      error: string | null;
      outcome: string | null;
      snapshot: unknown;
    },
  ): Promise<void>;
  insertProposal(proposal: ProposalRecord): Promise<void>;
  updateProposal(id: string, patch: ProposalPatch): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  /** Append-only. Written for EVERY evaluation, before anything is executed. */
  insertPolicyVerdict(verdict: PolicyVerdictRecord): Promise<void>;
  listPolicyVerdicts(options: {
    limit: number;
    verdict?: PolicyVerdict;
  }): Promise<Array<PolicyVerdictRecord & Provenance>>;
  /** The stored verdict for a decision id (own provenance only), or null. */
  findPolicyVerdict(id: string): Promise<Pick<PolicyVerdictRecord, 'verdict' | 'planHash'> | null>;
  insertExecutionRoute(route: ExecutionRouteRecord): Promise<void>;
  listExecutionRoutes(options: {
    limit: number;
    origin?: ExecutionRouteRecord['origin'];
  }): Promise<Array<ExecutionRouteRecord & Provenance>>;
  /** Lists return only rows written under this repository's own provenance (simulation never mixes with chain). */
  /** Live, executed proposals only: spend since `since` and the most recent execution time. */
  getExecutionStats(accountId: string, since: Date): Promise<PolicyHistory>;
  listRuns(limit: number): Promise<Array<RunRecord & Provenance & { proposalCount: number }>>;
  listProposals(options: {
    limit: number;
    runId?: string;
  }): Promise<Array<ProposalRecord & Provenance>>;
  ping(): Promise<void>;
}
