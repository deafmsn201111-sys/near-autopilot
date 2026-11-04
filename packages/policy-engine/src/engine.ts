import { planHash } from '@near-autopilot/core/hash';
import {
  usdToMicro,
  type ApprovalAuthority,
  type ApprovedPlan,
  type Clock,
  type IdGenerator,
  type PlannedTransaction,
  type PolicyDecision,
  type PolicyOutcome,
  type PolicyViolation,
} from '@near-autopilot/core';
import type { PolicyConfig } from './config';
import {
  DEFAULT_RULES,
  valueIntentUsd,
  type PolicyInput,
  type Rule,
  type RuleContext,
} from './rules';

export class PolicyEngine implements ApprovalAuthority {
  private readonly limits: RuleContext['limits'];
  /** Decisions this engine produced, each bound to the hash of the plan it evaluated. Single use. */
  private readonly evaluated = new WeakMap<PolicyDecision, string>();
  /** Approvals this engine minted. The brand is compile-time only; this is the run-time proof. */
  private readonly issued = new WeakSet<ApprovedPlan>();

  constructor(
    readonly config: PolicyConfig,
    private readonly deps: { clock: Clock; ids: IdGenerator },
    private readonly rules: readonly Rule[] = DEFAULT_RULES,
  ) {
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
    const violations: PolicyViolation[] = this.rules.flatMap((rule) => rule(context));
    const outcome: PolicyOutcome = violations.some((v) => v.severity === 'reject')
      ? 'reject'
      : violations.length > 0
        ? 'require_approval'
        : 'approve';
    const decision: PolicyDecision = Object.freeze({
      id: this.deps.ids.next(),
      intentId: input.intent.id,
      outcome,
      violations,
      evaluatedAt: now,
      valueUsdMicro: context.valueUsdMicro,
    });
    this.evaluated.set(decision, planHash(input.plan));
    return decision;
  }

  /**
   * The only way to obtain an `ApprovedPlan`. Accepts only a decision this engine produced, for the exact plan it
   * evaluated, once.
   */
  approve(plan: PlannedTransaction, decision: PolicyDecision): ApprovedPlan {
    const evaluatedHash = this.evaluated.get(decision);
    if (evaluatedHash === undefined) {
      throw new Error('Decision was not produced by this policy engine (or was already used)');
    }
    if (decision.outcome !== 'approve') {
      throw new Error(`Cannot approve a plan whose decision outcome is "${decision.outcome}"`);
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
    }) as ApprovedPlan;
    this.issued.add(approved);
    return approved;
  }

  isAuthentic(approved: ApprovedPlan): boolean {
    return this.issued.has(approved);
  }
}
