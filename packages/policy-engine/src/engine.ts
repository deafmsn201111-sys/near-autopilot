import { planHash, sha256Hex } from '@near-autopilot/core/hash';
import {
  canonicalJson,
  usdToMicro,
  verdictOf,
  type ApprovalAuthority,
  type ApprovedPlan,
  type Clock,
  type IdGenerator,
  type PlannedTransaction,
  type PolicyCheck,
  type PolicyDecision,
  type PolicyOutcome,
  type PolicyViolation,
} from '@near-autopilot/core';
import type { PolicyConfig } from './config';
import {
  DEFAULT_RULES,
  RULES_VERSION,
  valueIntentUsd,
  type NamedRule,
  type PolicyInput,
  type RuleContext,
} from './rules';

/** Content id of a snapshot: the same balances, prices, risk and tokens always give the same id (replayable). */
export const snapshotId = (snapshot: PolicyInput['snapshot']): string =>
  `sha256:${sha256Hex(canonicalJson(snapshot))}`;

export class PolicyEngine implements ApprovalAuthority {
  private readonly limits: RuleContext['limits'];
  /** Decisions this engine produced, each bound to the hash of the plan it evaluated. Single use. */
  private readonly evaluated = new WeakMap<PolicyDecision, string>();
  /** Approvals this engine minted. The brand is compile-time only; this is the run-time proof. */
  private readonly issued = new WeakSet<ApprovedPlan>();

  /** Rules version + hash of the exact config in force: two decisions with the same version used the same policy. */
  readonly version: string;

  constructor(
    readonly config: PolicyConfig,
    private readonly deps: { clock: Clock; ids: IdGenerator },
    private readonly rules: readonly NamedRule[] = DEFAULT_RULES,
  ) {
    this.version = `${RULES_VERSION}+cfg:${sha256Hex(canonicalJson(config)).slice(0, 16)}`;
    this.limits = {
      maxActionUsdMicro: usdToMicro(config.maxActionUsd),
      dailyLimitUsdMicro: usdToMicro(config.dailyLimitUsd),
      approvalThresholdUsdMicro: usdToMicro(config.approvalThresholdUsd),
    };
  }

  /** Runs every rule (no short-circuit, so the audit trail lists all violations). */
  evaluate(input: PolicyInput): PolicyDecision {
    const now = this.deps.clock.now();
    const context: RuleContext = {
      ...input,
      config: this.config,
      now,
      valueUsdMicro: valueIntentUsd(input.intent, input.snapshot),
      limits: this.limits,
    };
    const checks: PolicyCheck[] = [];
    const violations: PolicyViolation[] = [];
    for (const rule of this.rules) {
      const found = rule.check(context);
      violations.push(...found);
      checks.push({
        rule: rule.id,
        result: found.some((v) => v.severity === 'reject')
          ? 'BLOCK'
          : found.length > 0
            ? 'WARN'
            : 'PASS',
        messages: found.map((v) => v.message),
      });
    }
    const outcome: PolicyOutcome = violations.some((v) => v.severity === 'reject')
      ? 'reject'
      : violations.length > 0
        ? 'require_approval'
        : 'approve';
    const hash = planHash(input.plan);
    const decision: PolicyDecision = Object.freeze({
      id: this.deps.ids.next(),
      intentId: input.intent.id,
      outcome,
      verdict: verdictOf(outcome),
      violations,
      checks,
      evaluatedAt: now,
      valueUsdMicro: context.valueUsdMicro,
      policyVersion: this.version,
      snapshotId: snapshotId(input.snapshot),
      planHash: hash,
    });
    this.evaluated.set(decision, hash);
    return decision;
  }

  /**
   * The only way to obtain an `ApprovedPlan`. Accepts only a decision this engine produced, for the exact plan it
   * evaluated, once.
   */
  approve(plan: PlannedTransaction, decision: PolicyDecision): ApprovedPlan {
    if (decision.outcome !== 'approve') {
      throw new Error(`Cannot approve a plan whose decision outcome is "${decision.outcome}"`);
    }
    return this.mint(plan, decision, null);
  }

  /**
   * A HUMAN approval of a decision that needs one ("require_approval": every violation is approval-severity, none is
   * a rejection). Only for a decision this engine produced, for the exact plan it evaluated, once, within
   * approvalTtlSeconds of the evaluation, and with a named approver. A rejected decision can never be approved, by
   * anyone: limits such as the per-action maximum stay absolute.
   */
  approveByOperator(
    plan: PlannedTransaction,
    decision: PolicyDecision,
    approvedBy: string,
  ): ApprovedPlan {
    if (!approvedBy.trim()) throw new Error('An operator approval needs a named approver');
    if (decision.outcome !== 'require_approval') {
      throw new Error(
        `Only a decision that requires approval can be approved by an operator, not "${decision.outcome}"`,
      );
    }
    if (decision.violations.some((v) => v.severity !== 'approval')) {
      throw new Error('The decision has a rejecting violation; it cannot be approved');
    }
    const age = this.deps.clock.now().getTime() - decision.evaluatedAt.getTime();
    if (age > this.config.approvalTtlSeconds * 1000) {
      throw new Error(
        `The decision is ${Math.round(age / 1000)} s old; approvals expire after ${this.config.approvalTtlSeconds} s`,
      );
    }
    return this.mint(plan, decision, approvedBy.trim());
  }

  private mint(
    plan: PlannedTransaction,
    decision: PolicyDecision,
    approvedBy: string | null,
  ): ApprovedPlan {
    const evaluatedHash = this.evaluated.get(decision);
    if (evaluatedHash === undefined) {
      throw new Error('Decision was not produced by this policy engine (or was already used)');
    }
    if (decision.intentId !== plan.intentId) {
      throw new Error('Decision was made for a different intent than this plan');
    }
    const hash = planHash(plan);
    if (hash !== evaluatedHash) {
      throw new Error('Plan differs from the plan this decision evaluated');
    }
    this.evaluated.delete(decision);
    const approvedAt = this.deps.clock.now();
    // The single place the ApprovedPlan brand is applied; `issued` makes it verifiable at run time.
    const approved = Object.freeze({
      plan,
      decisionId: decision.id,
      planHash: hash,
      approvedAt,
      expiresAt: new Date(approvedAt.getTime() + this.config.approvalTtlSeconds * 1000),
      ...(approvedBy ? { approvedBy } : {}),
    }) as ApprovedPlan;
    this.issued.add(approved);
    return approved;
  }

  isAuthentic(approved: ApprovedPlan): boolean {
    return this.issued.has(approved);
  }
}
