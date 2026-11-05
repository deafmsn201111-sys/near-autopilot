import { toJsonSafe, type PolicyDecision } from '@near-autopilot/core';
import type { PolicyInput } from '@near-autopilot/policy-engine';
import type { AutopilotRepository, PolicyVerdictRecord } from '../repository';

/**
 * A policy decision as stored in `policy_verdicts`: verdict, every check, policy version, snapshot id, plan hash and
 * the exact evaluation input (JSON-safe; bigint as decimal text, Date as ISO), so the decision can be re-evaluated.
 */
export function verdictRecord(
  decision: PolicyDecision,
  input: PolicyInput,
  engine: PolicyVerdictRecord['engine'],
  runId: string | null,
): PolicyVerdictRecord {
  return {
    id: decision.id,
    evaluatedAt: decision.evaluatedAt,
    engine,
    runId,
    intentId: decision.intentId,
    intentKind: input.intent.kind,
    verdict: decision.verdict,
    outcome: decision.outcome,
    policyVersion: decision.policyVersion,
    snapshotId: decision.snapshotId,
    planHash: decision.planHash,
    valueUsdMicro: decision.valueUsdMicro,
    checks: decision.checks,
    violations: decision.violations,
    input: toJsonSafe({
      intent: input.intent,
      plan: input.plan,
      snapshot: input.snapshot,
      history: input.history,
    }),
  };
}

/** The orchestrator's VerdictSink over the repository (the cycle key stands in for a run id). */
export const repositoryVerdictSink = (repo: Pick<AutopilotRepository, 'insertPolicyVerdict'>) => ({
  record: (decision: PolicyDecision, input: PolicyInput, cycleKey: string) =>
    repo.insertPolicyVerdict(verdictRecord(decision, input, 'orchestrator', cycleKey)),
});
