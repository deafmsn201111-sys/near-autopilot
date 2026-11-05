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
