import { planHash } from '@near-autopilot/core/hash';
import {
  usdToMicro,
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

export class PolicyEngine {
  private readonly limits: RuleContext['limits'];

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
    return {
      id: this.deps.ids.next(),
      intentId: input.intent.id,
      outcome,
      violations,
      evaluatedAt: now,
      valueUsdMicro: context.valueUsdMicro,
    };
  }

  /** The only way to obtain an `ApprovedPlan`. Binds the approval to the exact plan content. */
  approve(plan: PlannedTransaction, decision: PolicyDecision): ApprovedPlan {
    if (decision.outcome !== 'approve') {
      throw new Error(`Cannot approve a plan whose decision outcome is "${decision.outcome}"`);
    }
    if (decision.intentId !== plan.intentId) {
      throw new Error('Decision was made for a different intent than this plan');
    }
    const approvedAt = this.deps.clock.now();
    return {
      plan,
      decisionId: decision.id,
      planHash: planHash(plan),
      approvedAt,
      expiresAt: new Date(approvedAt.getTime() + this.config.approvalTtlSeconds * 1000),
    } as ApprovedPlan;
  }
}
