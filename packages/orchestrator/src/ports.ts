import type {
  AccountId,
  ActionIntent,
  ApprovedPlan,
  PlannedTransaction,
  PolicyDecision,
  PortfolioSnapshot,
  SwapQuoteRequest,
  TokenId,
} from '@near-autopilot/core';
import type { AgentId } from './proposals';
import type { ActionStatus, AgentObservation, MarketContext, Mode, RecentAction } from './types';

/* ------------------------------ agents ------------------------------ */

/**
 * An agent turns an observation into UNTRUSTED output. It returns `unknown` on purpose: the type system cannot vouch
 * for what an LLM wrote, so the orchestrator validates every agent's output with the same strict parser.
 * An agent gets plain data only: no signer, no executor, no policy, no network capability is passed to it.
 */
export interface ProposalAgent {
  readonly id: AgentId;
  propose(observation: AgentObservation): Promise<unknown>;
}

/** Minimal text-completion client for LLM-backed agents. It has no tools; whatever it returns is just a string. */
export interface LlmClient {
  complete(prompt: string): Promise<string>;
}

export interface LlmToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the tool's input object. */
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResult {
  readonly id: string;
  readonly content: string;
  readonly isError: boolean;
}

export type LlmToolTurn =
  | { readonly kind: 'tool_calls'; readonly calls: readonly ToolCall[] }
  | { readonly kind: 'final'; readonly text: string };

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A reply a provider signs: hashes of the exact request and response bytes, so the signature can be checked later. */
export interface SignedReply {
  readonly chatId: string;
  readonly requestSha256: string;
  readonly responseSha256: string;
}

/** One conversation. The first `send` passes null; every later one answers the previous turn's tool calls. */
export interface ToolChat {
  send(results: readonly ToolResult[] | null): Promise<LlmToolTurn>;
}

/** A model that can call tools. It only ever sees tool OUTPUT; the tools themselves run in our process. */
export interface ToolLlm {
  open(request: {
    readonly system: string;
    readonly prompt: string;
    readonly tools: readonly LlmToolSpec[];
    /** Aborts the model call in flight. */
    readonly signal?: AbortSignal;
    /** Called with the billed tokens of every reply as it arrives, before the reply is checked (so also on a throw). */
    readonly onUsage?: (usage: LlmUsage) => void;
    /** Called for every reply of a provider that signs them, before the reply is checked. */
    readonly onReply?: (reply: SignedReply) => void;
  }): ToolChat;
}

/* ------------------------------ data ------------------------------ */

export interface SnapshotProvider {
  take(): Promise<PortfolioSnapshot>;
}

export interface MarketProvider {
  get(): Promise<MarketContext | null>;
}

/** Read-only quoting. Same request shape as core `SwapQuoter`, which satisfies this port structurally. */
export interface QuoteProvider {
  /** Best executable quote for exactly this amount, or null. */
  quote(
    request: SwapQuoteRequest,
  ): Promise<{ poolId: number; amountIn: bigint; amountOut: bigint } | null>;
  /**
   * The token pairs an allowlisted pool connects (either direction). Agents only propose swaps along them, so a
   * proposal is never made for a trade that has no permitted route. Absent: no restriction is known.
   */
  pairs?(): readonly (readonly [TokenId, TokenId])[];
}

/* ------------------------------ authorisation and execution ------------------------------ */

export interface IntentPlanner {
  plan(intent: ActionIntent, signerId: AccountId): Promise<PlannedTransaction>;
}

export interface PolicyHistoryView {
  readonly spentLast24hUsdMicro: bigint;
  readonly lastExecutedAt: Date | null;
}

export interface ExecutionHistory {
  stats(accountId: AccountId, since: Date): Promise<PolicyHistoryView>;
}

/**
 * The policy engine, seen through the only two calls the orchestrator needs. `PolicyEngine` satisfies this
 * structurally. `approve` is the sole source of `ApprovedPlan`, so nothing the orchestrator does can bypass policy.
 */
export interface PolicyGate {
  evaluate(input: {
    intent: ActionIntent;
    plan: PlannedTransaction;
    snapshot: PortfolioSnapshot;
    history: PolicyHistoryView;
  }): PolicyDecision;
  approve(plan: PlannedTransaction, decision: PolicyDecision): ApprovedPlan;
}

/** Persists every policy decision with its exact inputs (fail closed: a verdict that cannot be stored is not acted on). */
export interface VerdictSink {
  record(
    decision: PolicyDecision,
    input: {
      intent: ActionIntent;
      plan: PlannedTransaction;
      snapshot: PortfolioSnapshot;
      history: PolicyHistoryView;
    },
    cycleKey: string,
  ): Promise<void>;
}

/* ------------------------------ operations ------------------------------ */

export type Severity = 'info' | 'warn' | 'page';

export interface EscalationEvent {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly cycleKey: string | null;
  readonly decisionId: string | null;
  readonly at: Date;
}

export interface Notifier {
  notify(event: EscalationEvent): Promise<void>;
}

export interface AuditEntryInput {
  readonly at: Date;
  readonly type: string;
  readonly cycleKey: string | null;
  readonly decisionId: string | null;
  /** JSON-safe payload. Never put secrets or raw model output beyond a bounded excerpt here. */
  readonly payload: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * Append-only and tamper-evident: each entry commits to the previous one. `append` must either durably store the
 * entry or throw; the orchestrator refuses to execute anything it could not record.
 */
export interface AuditLog {
  append(entry: AuditEntryInput): Promise<AuditEntry>;
  entries(): Promise<readonly AuditEntry[]>;
  verify(): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }>;
}

/** Operator-visible control state. Missing or unreadable state is treated as read-only. */
export interface ControlState {
  readonly mode: Mode;
  readonly reason: string;
  readonly since: Date;
  readonly changedBy: string;
  readonly consecutiveFailures: number;
  readonly blindCycles: number;
  readonly quarantined: Readonly<Partial<Record<AgentId, { since: Date; reason: string }>>>;
}

export interface ControlStore {
  load(): Promise<ControlState>;
  save(next: ControlState): Promise<void>;
}

export type CycleState = 'in_progress' | 'completed' | 'needs_reconciliation';

export interface CycleRecord {
  readonly key: string;
  readonly state: CycleState;
  readonly startedAt: Date;
  /** Set immediately before an executor is called. A crash after this point leaves the chain state UNKNOWN. */
  readonly executionStartedFor: string | null;
  readonly summary: CycleSummary | null;
}

export interface CycleSummary {
  readonly outcome: string;
  readonly decisionId: string | null;
  readonly executed: boolean;
  readonly detail: string;
}

export interface ActionRecord {
  readonly actionKey: string;
  /** Candidate action kind, e.g. 'lending.repay'. Lets the engine tell risk reductions from discretionary trades. */
  readonly kind: string;
  readonly decisionId: string;
  readonly cycleKey: string;
  readonly status: ActionStatus;
  readonly at: Date;
  readonly txHash: string | null;
}

/** Cycle- and action-level idempotency. `begin` must be atomic across processes in a real implementation. */
export interface IdempotencyStore {
  begin(
    key: string,
    now: Date,
    takeOverAfterSeconds: number,
  ): Promise<{ claimed: true; tookOver: boolean } | { claimed: false; existing: CycleRecord }>;
  markExecutionStarted(key: string, actionKey: string): Promise<void>;
  complete(key: string, summary: CycleSummary): Promise<void>;
  markNeedsReconciliation(key: string): Promise<void>;
  recordAction(record: ActionRecord): Promise<void>;
  updateAction(
    actionKey: string,
    decisionId: string,
    patch: { status: ActionStatus; txHash: string | null },
  ): Promise<void>;
  recentActions(since: Date): Promise<readonly RecentAction[]>;
  /** Cycles that are in_progress with execution started: possible in-doubt transactions. */
  inDoubt(): Promise<readonly CycleRecord[]>;
}
