import { canonicalJson, errorMessage, type PolicyDecision } from '@near-autopilot/core';
import { planHash } from '@near-autopilot/core/hash';
import { PolicyEngine, snapshotId, type PolicyConfig } from '@near-autopilot/policy-engine';
import { decodeVerdictInput } from './decode';

/**
 * REPLAY: re-evaluate a stored verdict from its row alone and compare. Nothing is fetched and nothing is executed; the
 * policy engine runs on the stored input with the clock fixed at the stored evaluation time.
 *
 * Checked in order, each a separate finding:
 *   config      the stored config (or a supplied one, for rows that predate config recording) hashes to the stored
 *               policyVersion; otherwise the rules or the limits are not the ones the verdict was made under
 *   snapshot_id the decoded snapshot hashes to the stored snapshot id (the stored input is the one that was evaluated)
 *   plan_hash   the decoded plan hashes to the stored plan hash
 *   verdict     verdict, outcome, every check, every violation and the valuation are identical
 */
export interface StoredVerdict {
  readonly id: string;
  readonly evaluatedAt: Date;
  readonly verdict: string;
  readonly outcome: string;
  readonly policyVersion: string;
  readonly snapshotId: string;
  readonly planHash: string;
  readonly valueUsdMicro: string | null;
  readonly checks: unknown;
  readonly violations: unknown;
  readonly input: unknown;
}

export type ReplayResult =
  | {
      readonly id: string;
      readonly status: 'match';
      readonly verdict: string;
      readonly configFrom: 'row' | 'file';
    }
  | {
      readonly id: string;
      readonly status: 'mismatch';
      readonly stage: 'config' | 'snapshot_id' | 'plan_hash' | 'verdict';
      readonly detail: string;
    }
  | { readonly id: string; readonly status: 'not_replayable'; readonly detail: string };

/** The clock is fixed at the stored evaluation time: freshness and cooldown are judged as they were then. */
const fixedClock = (at: Date) => ({ now: () => new Date(at.getTime()) });
const replayIds = () => {
  let n = 0;
  return { next: () => `replay-${(n += 1)}` };
};

const versionOf = (config: PolicyConfig): string =>
  new PolicyEngine(config, { clock: fixedClock(new Date(0)), ids: replayIds() }).version;

export function replayVerdict(
  row: StoredVerdict,
  /** Configs available for rows stored without one (matched by version, never assumed). */
  fallbackConfigs: readonly PolicyConfig[] = [],
): ReplayResult {
  let decoded;
  try {
    decoded = decodeVerdictInput(row.input);
  } catch (e) {
    return {
      id: row.id,
      status: 'not_replayable',
      detail: `stored input does not decode: ${errorMessage(e)}`,
    };
  }
  let config: PolicyConfig;
  let configFrom: 'row' | 'file';
  if (decoded.config) {
    if (versionOf(decoded.config) !== row.policyVersion)
      return {
        id: row.id,
        status: 'mismatch',
        stage: 'config',
        detail: `stored config hashes to ${versionOf(decoded.config)}, the verdict says ${row.policyVersion}`,
      };
    config = decoded.config;
    configFrom = 'row';
  } else {
    const match = fallbackConfigs.find((c) => versionOf(c) === row.policyVersion);
    if (!match)
      return {
        id: row.id,
        status: 'not_replayable',
        detail: `stored without its config, and no supplied config has version ${row.policyVersion}`,
      };
    config = match;
    configFrom = 'file';
  }
  const { input } = decoded;
  if (snapshotId(input.snapshot) !== row.snapshotId)
    return {
      id: row.id,
      status: 'mismatch',
      stage: 'snapshot_id',
      detail: 'the stored snapshot does not hash to the stored snapshot id',
    };
  if (planHash(input.plan) !== row.planHash)
    return {
      id: row.id,
      status: 'mismatch',
      stage: 'plan_hash',
      detail: 'the stored plan does not hash to the stored plan hash',
    };

  const engine = new PolicyEngine(config, {
    clock: fixedClock(row.evaluatedAt),
    ids: replayIds(),
  });
  const again: PolicyDecision = engine.evaluate(input);
  const now = {
    verdict: again.verdict,
    outcome: again.outcome,
    policyVersion: again.policyVersion,
    valueUsdMicro: again.valueUsdMicro === null ? null : again.valueUsdMicro.toString(),
    checks: again.checks,
    violations: again.violations,
  };
  const then = {
    verdict: row.verdict,
    outcome: row.outcome,
    policyVersion: row.policyVersion,
    valueUsdMicro: row.valueUsdMicro,
    checks: row.checks,
    violations: row.violations,
  };
  const diff = (Object.keys(now) as Array<keyof typeof now>).filter(
    (k) => canonicalJson(now[k]) !== canonicalJson(then[k]),
  );
  return diff.length === 0
    ? { id: row.id, status: 'match', verdict: again.verdict, configFrom }
    : {
        id: row.id,
        status: 'mismatch',
        stage: 'verdict',
        detail: diff
          .map((k) => `${k}: stored ${canonicalJson(then[k])}, replayed ${canonicalJson(now[k])}`)
          .join('; '),
      };
}
