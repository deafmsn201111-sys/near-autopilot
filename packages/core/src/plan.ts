import type { Brand } from './brand';
import type { AccountId } from './ids';

export interface FunctionCallAction {
  readonly type: 'FunctionCall';
  readonly methodName: string;
  /** JSON-serialisable arguments (amounts as decimal strings). */
  readonly args: Readonly<Record<string, unknown>>;
  /** Gas in gas units (1 Tgas = 10^12). */
  readonly gas: bigint;
  /** Attached deposit in yoctoNEAR. */
  readonly deposit: bigint;
}

/** A single NEAR transaction: one signer, one receiver, one or more actions. */
export interface PlannedTransaction {
  readonly intentId: string;
  readonly signerId: AccountId;
  readonly receiverId: AccountId;
  readonly actions: readonly FunctionCallAction[];
}

export type PolicyOutcome = 'approve' | 'require_approval' | 'reject';

export interface PolicyViolation {
  readonly rule: string;
  readonly message: string;
  /** `reject` blocks the action; `approval` downgrades the outcome to require_approval. */
  readonly severity: 'reject' | 'approval';
}

/** The decision as a reader sees it: ALLOW (approve), WARN (a human must approve), BLOCK (reject). */
export type PolicyVerdict = 'ALLOW' | 'WARN' | 'BLOCK';

/** One rule's result. Every rule runs every time, so a verdict always lists every check, passed or not. */
export interface PolicyCheck {
  readonly rule: string;
  readonly result: 'PASS' | 'WARN' | 'BLOCK';
  readonly messages: readonly string[];
}

export const verdictOf = (outcome: PolicyOutcome): PolicyVerdict =>
  outcome === 'approve' ? 'ALLOW' : outcome === 'require_approval' ? 'WARN' : 'BLOCK';

export interface PolicyDecision {
  readonly id: string;
  readonly intentId: string;
  readonly outcome: PolicyOutcome;
  readonly verdict: PolicyVerdict;
  readonly violations: readonly PolicyViolation[];
  readonly checks: readonly PolicyCheck[];
  readonly evaluatedAt: Date;
  /** Valuation the policy engine computed itself (micro-USD); never taken from the agent. */
  readonly valueUsdMicro: bigint | null;
  /** `<rules version>+cfg:<sha256 of the canonical policy config, 16 hex>`: changes whenever a rule or limit does. */
  readonly policyVersion: string;
  /** `sha256:<hex>` of the canonical snapshot the decision was made on (prices, balances, risk, tokens). */
  readonly snapshotId: string;
  /** sha256 of the canonical plan; an approval is bound to it. */
  readonly planHash: string;
}

/**
 * A plan the policy engine has approved. It can only be minted by `PolicyEngine.approve`: the brand enforces that
 * at compile time, and executors check `ApprovalAuthority.isAuthentic` plus `planHash` and `expiresAt` at run time.
 */
export type ApprovedPlan = Brand<
  {
    readonly plan: PlannedTransaction;
    readonly decisionId: string;
    readonly planHash: string;
    readonly approvedAt: Date;
    readonly expiresAt: Date;
    /** Set only by `PolicyEngine.approveByOperator`: the person who confirmed a decision that required approval. */
    readonly approvedBy?: string;
  },
  'ApprovedPlan'
>;

/**
 * `unknown`: the transaction was signed and handed to the network but the result could not be established (e.g. the
 * broadcast call errored). It may or may not have landed; `txHash` identifies it for reconciliation. Callers must
 * treat it as possibly executed: stop, count it against limits, and never retry automatically.
 */
export type ExecutionStatus = 'success' | 'failed' | 'dry_run' | 'rejected' | 'unknown';
export type ExecutionMode = 'dry-run' | 'live';

export interface ExecutionResult {
  readonly status: ExecutionStatus;
  readonly mode: ExecutionMode;
  readonly txHash: string | null;
  readonly error: string | null;
}
