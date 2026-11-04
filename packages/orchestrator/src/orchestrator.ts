import {
  canonicalJson,
  errorMessage,
  toJsonSafe,
  type AccountId,
  type Clock,
  type ExecutionResult,
  type Logger,
  type PlanExecutor,
  type PolicyViolation,
  type PortfolioSnapshot,
} from '@near-autopilot/core';
import { sha256Hex } from '@near-autopilot/core/hash';
import type { OrchestratorConfig } from './config';
import { checkDataQuality } from './data-guard';
import { candidateToIntent, decide } from './decision-engine';
import { assessEscalations } from './escalation';
import { ModeController } from './mode';
import type {
  AuditLog,
  ControlStore,
  EscalationEvent,
  ExecutionHistory,
  IdempotencyStore,
  IntentPlanner,
  MarketProvider,
  Notifier,
  PolicyGate,
  ProposalAgent,
  QuoteProvider,
  Severity,
  SnapshotProvider,
} from './ports';
import { parseAgentOutput, type AgentId, type ParsedProposal } from './proposals';
import { assessRisk } from './risk-state';
import type { AgentObservation, Candidate, Decision, MarketContext, QuoteInput } from './types';

export interface OrchestratorDeps {
  readonly accountId: AccountId;
  readonly config: OrchestratorConfig;
  readonly agents: readonly ProposalAgent[];
  readonly snapshots: SnapshotProvider;
  readonly market: MarketProvider | null;
  readonly quoter: QuoteProvider;
  readonly planner: IntentPlanner;
  /** The policy engine. The orchestrator can ask it questions; it cannot configure, bypass or override it. */
  readonly policy: PolicyGate;
  /** Signs and sends (or dry-runs) an ApprovedPlan. Wrapped so that read-only mode is enforced here too. */
  readonly executor: PlanExecutor;
  readonly history: ExecutionHistory;
  readonly audit: AuditLog;
  readonly idempotency: IdempotencyStore;
  readonly control: ControlStore;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly logger: Logger;
}

export type CycleStatus =
  | 'executed'
  | 'dry_run'
  | 'execution_failed'
  | 'execution_in_doubt'
  | 'pending_approval'
  | 'no_action'
  | 'read_only'
  | 'duplicate_cycle'
  | 'cycle_in_progress'
  | 'aborted';

export interface PolicyOutcomeSummary {
  readonly intentId: string;
  readonly proposalId: string;
  readonly outcome: string;
  readonly violations: readonly PolicyViolation[];
}

export interface CycleReport {
  readonly cycleKey: string;
  readonly status: CycleStatus;
  readonly detail: string;
  readonly decision: Decision | null;
  readonly policy: readonly PolicyOutcomeSummary[];
  readonly execution: ExecutionResult | null;
  readonly escalations: readonly EscalationEvent[];
  /** True when this key had already completed and the stored outcome was returned without doing anything. */
  readonly replayed: boolean;
}

class AuditUnavailableError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
const excerpt = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Excerpt of arbitrary agent output for the audit log. Must never throw: a hostile output cannot be allowed to abort the cycle. */
const safeExcerpt = (raw: unknown, n: number): string => {
  try {
    return excerpt(typeof raw === 'string' ? raw : canonicalJson(raw), n);
  } catch {
    return '[output could not be serialised]';
  }
};

/** Defence in depth: even if some other caller shares this executor, read-only mode still blocks it. */
export function guardExecutor(executor: PlanExecutor, mode: ModeController): PlanExecutor {
  return {
    async execute(approved) {
      const state = await mode.current();
      if (state.mode === 'read_only') {
        return {
          status: 'rejected',
          mode: 'dry-run',
          txHash: null,
          error: `read-only mode: ${state.reason}`,
        };
      }
      return executor.execute(approved);
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  if (ms <= 0) return { timedOut: false, value: await promise };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The cycle:
 *
 *   claim cycle key -> observe -> data guard -> agents -> strict parse -> quotes -> DECIDE (pure)
 *   -> for each ranked candidate: plan -> POLICY (separate engine) -> re-check freshness and mode -> execute
 *
 * Safety properties, each with a test in test/scenarios:
 *  - Agents (LLM or not) hand over text. It is parsed by one strict schema; nothing in it can name a contract,
 *    method, argument, key or limit. Transactions come from protocol planners, authority from the policy engine.
 *  - The only way to obtain an ApprovedPlan is `policy.approve`, called after the decision, the policy verdict and a
 *    second freshness/mode check have all passed. Read-only mode returns before that point.
 *  - Nothing is executed that was not durably audited first. If the audit log is down, the cycle stops.
 *  - A cycle key is processed at most once; replays return the stored outcome. A crash after the executor was called
 *    but before the result was recorded leaves a visible in-doubt record and freezes the system until a human
 *    reconciles it. The orchestrator never guesses whether a transaction landed.
 */
export class Orchestrator {
  private running = false;
  private readonly mode: ModeController;
  private readonly executor: PlanExecutor;

  constructor(private readonly deps: OrchestratorDeps) {
    this.mode = new ModeController(deps.control, deps.clock);
    this.executor = guardExecutor(deps.executor, this.mode);
  }

  /* ------------------------------ operator controls ------------------------------ */

  async engageEmergencyReadOnly(reason: string, by: string): Promise<void> {
    const state = await this.mode.engageReadOnly(reason, by);
    await this.record(
      'mode.read_only_engaged',
      { reason, by, mode: state.mode },
      null,
      null,
      false,
    );
    await this.escalate(
      'page',
      'EMERGENCY_READ_ONLY',
      `emergency read-only mode engaged by ${by}: ${reason}`,
      null,
      null,
    );
  }

  /** The only way out of read-only mode. Needs a named actor and a reason; both are audited. */
  async setMode(
    mode: 'normal' | 'risk_reduction_only' | 'read_only',
    reason: string,
    by: string,
  ): Promise<void> {
    await this.mode.setMode(mode, reason, by);
    await this.record('mode.changed', { mode, reason, by }, null, null, false);
  }

  async releaseAgent(agent: AgentId, by: string): Promise<void> {
    await this.mode.releaseAgent(agent, by);
    await this.record('agent.released', { agent, by }, null, null, false);
  }

  /** A human has established what happened to an in-doubt execution. Does not leave read-only mode by itself. */
  async reconcile(cycleKey: string, by: string, resolution: string): Promise<void> {
    if (!by.trim() || !resolution.trim())
      throw new RangeError('reconciling needs an actor and a resolution');
    await this.deps.idempotency.complete(cycleKey, {
      outcome: 'reconciled',
      decisionId: null,
      executed: false,
      detail: resolution,
    });
    await this.record('cycle.reconciled', { cycleKey, by, resolution }, cycleKey, null, false);
  }

  async controlState() {
    return this.mode.current();
  }

  /* ------------------------------ the cycle ------------------------------ */

  async runCycle(cycleKey: string): Promise<CycleReport> {
    if (this.running) {
      return this.bare(cycleKey, 'cycle_in_progress', 'another cycle is running in this process');
    }
    this.running = true;
    const escalations: EscalationEvent[] = [];
    try {
      return await this.cycle(cycleKey, escalations);
    } catch (error) {
      // Anything unexpected: fail closed. Nothing has been executed that was not already recorded.
      this.deps.logger.error('cycle aborted', { cycleKey, error: errorMessage(error) });
      const failedClosed = error instanceof AuditUnavailableError;
      if (failedClosed) await this.mode.tighten('read_only', 'audit log unavailable', 'system');
      await this.escalate(
        'page',
        failedClosed ? 'AUDIT_UNAVAILABLE' : 'CYCLE_ABORTED',
        `cycle ${cycleKey} aborted: ${errorMessage(error)}`,
        cycleKey,
        null,
        escalations,
      );
      await this.safely(() =>
        this.deps.idempotency.complete(cycleKey, {
          outcome: 'aborted',
          decisionId: null,
          executed: false,
          detail: errorMessage(error),
        }),
      );
      return { ...this.bare(cycleKey, 'aborted', errorMessage(error)), escalations };
    } finally {
      this.running = false;
    }
  }

  private async cycle(cycleKey: string, escalations: EscalationEvent[]): Promise<CycleReport> {
    const d = this.deps;
    const cfg = d.config;
    const now = d.clock.now();

    // 1. Idempotency: claim the key.
    const claim = await d.idempotency.begin(cycleKey, now, cfg.execution.inProgressTimeoutSeconds);
    if (!claim.claimed) {
      const e = claim.existing;
      if (e.state === 'completed') {
        await this.record(
          'cycle.replayed',
          { outcome: e.summary?.outcome ?? null },
          cycleKey,
          e.summary?.decisionId ?? null,
          false,
        );
        return {
          ...this.bare(
            cycleKey,
            'duplicate_cycle',
            `already completed: ${e.summary?.detail ?? ''}`,
          ),
          replayed: true,
        };
      }
      if (e.state === 'needs_reconciliation' || e.executionStartedFor !== null) {
        await this.escalate(
          'page',
          'IN_DOUBT_EXECUTION',
          `cycle ${cycleKey} started executing and never recorded a result`,
          cycleKey,
          null,
          escalations,
        );
        await this.mode.tighten('read_only', `in-doubt execution in cycle ${cycleKey}`);
        await d.idempotency.markNeedsReconciliation(cycleKey);
        return {
          ...this.bare(
            cycleKey,
            'execution_in_doubt',
            'a previous attempt may have sent a transaction; reconcile manually',
          ),
          escalations,
        };
      }
      return this.bare(cycleKey, 'cycle_in_progress', 'this cycle key is being processed');
    }

    await this.record('cycle.started', { tookOver: claim.tookOver }, cycleKey, null, true);

    // 2. Any unreconciled in-doubt execution freezes automation.
    const doubts = (await d.idempotency.inDoubt()).filter((c) => c.key !== cycleKey);
    if (doubts.length > 0) {
      await this.mode.tighten('read_only', `in-doubt execution in cycle ${doubts[0]?.key}`);
      await this.escalate(
        'page',
        'IN_DOUBT_EXECUTION',
        `${doubts.length} execution(s) are in doubt: ${doubts.map((c) => c.key).join(', ')}`,
        cycleKey,
        null,
        escalations,
      );
    }

    // 3. Observe. Provider failures are data problems, not crashes.
    let snapshot: PortfolioSnapshot | null = null;
    try {
      snapshot = await d.snapshots.take();
    } catch (error) {
      await this.record(
        'observation.snapshot_failed',
        { error: errorMessage(error) },
        cycleKey,
        null,
        true,
      );
    }
    let market: MarketContext | null = null;
    if (d.market) {
      try {
        market = await d.market.get();
      } catch (error) {
        await this.record(
          'observation.market_failed',
          { error: errorMessage(error) },
          cycleKey,
          null,
          true,
        );
      }
    }

    const dq = checkDataQuality({
      now,
      expectedAccount: d.accountId,
      snapshot,
      market,
      config: cfg,
    });
    const borrowing = (snapshot?.lending?.borrowed ?? []).some((b) => b.raw > 0n);
    let state = await this.mode.current();

    if (!snapshot) {
      // Without a snapshot we cannot even tell whether a borrow is open, so assume one might be: after the same number
      // of blind cycles that pages when data is stale while borrowing, page here too.
      const blind = (await this.mode.recordBlindCycle(true)).blindCycles;
      const paging = blind >= cfg.execution.staleCyclesBeforePage;
      await this.escalate(
        paging ? 'page' : 'warn',
        paging ? 'GUARDIAN_BLIND' : 'SNAPSHOT_UNAVAILABLE',
        paging
          ? `${blind} consecutive cycle(s) without any snapshot; an open borrow (if any) is unmonitored`
          : 'no snapshot could be taken; no action is possible',
        cycleKey,
        null,
        escalations,
      );
      return this.finishNoDecision(cycleKey, 'no_action', 'no snapshot available', escalations);
    }

    const risk = assessRisk(snapshot, cfg);
    for (const e of assessEscalations({ risk, data: dq, state, borrowing, config: cfg })) {
      await this.escalate(e.severity, e.code, e.message, cycleKey, null, escalations);
    }
    await this.mode.recordBlindCycle(dq.blocking && borrowing);
    await this.record(
      'observation',
      {
        takenAt: snapshot.takenAt,
        pricesAsOf: snapshot.pricesAsOf,
        dataIssues: dq.issues,
        risk: { level: risk.level, healthFactorWad: risk.healthFactorWad, ltvBps: risk.ltvBps },
      },
      cycleKey,
      null,
      true,
    );

    // 4. Agents. Each gets its own deep copy; its output is untrusted.
    state = await this.mode.current();
    const quarantined = new Set<AgentId>(Object.keys(state.quarantined) as AgentId[]);
    const proposals: ParsedProposal[] = [];
    const suspicious = new Set<AgentId>();
    const seen = new Set<string>();
    const baseObservation: AgentObservation = {
      now,
      accountId: d.accountId,
      snapshot,
      market,
      risk,
      config: cfg,
    };

    for (const agent of d.agents) {
      if (quarantined.has(agent.id)) {
        await this.record(
          'agent.skipped',
          { agent: agent.id, reason: 'quarantined' },
          cycleKey,
          null,
          true,
        );
        continue;
      }
      let raw: unknown;
      try {
        const outcome = await withTimeout(
          agent.propose(structuredClone(baseObservation)),
          cfg.execution.agentTimeoutMs,
        );
        if (outcome.timedOut) {
          await this.record(
            'agent.timeout',
            { agent: agent.id, ms: cfg.execution.agentTimeoutMs },
            cycleKey,
            null,
            true,
          );
          continue;
        }
        raw = outcome.value;
      } catch (error) {
        await this.record(
          'agent.error',
          { agent: agent.id, error: errorMessage(error) },
          cycleKey,
          null,
          true,
        );
        continue;
      }

      const parsed = parseAgentOutput(agent.id, raw);
      await this.record(
        'agent.output',
        {
          agent: agent.id,
          accepted: parsed.proposals.length,
          issues: parsed.issues,
          suspicious: parsed.suspicious,
          // Bounded excerpt of what was rejected, for forensics. Never the full model output.
          rejectedExcerpt: parsed.issues.length > 0 ? safeExcerpt(raw, 500) : null,
          proposals: parsed.proposals.map((p) => ({
            kind: p.proposal.kind,
            rationale: excerpt(p.proposal.rationale),
          })),
        },
        cycleKey,
        null,
        true,
      );

      if (parsed.suspicious) {
        suspicious.add(agent.id);
        await this.mode.quarantine(agent.id, 'output contained forbidden fields or impersonation');
        await this.escalate(
          'page',
          'INJECTION_SUSPECTED',
          `${agent.id} produced output with forbidden fields: its output is discarded and the agent is quarantined`,
          cycleKey,
          null,
          escalations,
        );
        continue;
      }
      if (parsed.issues.length >= cfg.agents.quarantineAfterInvalid) {
        await this.mode.quarantine(
          agent.id,
          `${parsed.issues.length} invalid outputs in one cycle`,
        );
        await this.escalate(
          'warn',
          'AGENT_QUARANTINED',
          `${agent.id} produced ${parsed.issues.length} invalid outputs and is quarantined`,
          cycleKey,
          null,
          escalations,
        );
        continue;
      }
      if (parsed.issues.length > 0) {
        await this.escalate(
          'info',
          'AGENT_OUTPUT_INVALID',
          `${agent.id} produced ${parsed.issues.length} unusable output item(s): ${parsed.issues.map((i) => i.code).join(', ')}`,
          cycleKey,
          null,
          escalations,
        );
      }
      for (const p of parsed.proposals) {
        const proposalId = sha256Hex(canonicalJson({ agent: p.agent, proposal: p.proposal }));
        if (seen.has(proposalId)) continue;
        seen.add(proposalId);
        proposals.push({ ...p, proposalId });
      }
    }
    if (suspicious.size >= 2) {
      await this.mode.tighten(
        'read_only',
        'two or more agents produced suspicious output in one cycle',
      );
      await this.escalate(
        'page',
        'COORDINATED_INJECTION_SUSPECTED',
        'several agents were manipulated in the same cycle; emergency read-only mode engaged',
        cycleKey,
        null,
        escalations,
      );
    }

    // 5. Quotes for swap proposals (read-only calls).
    const quotes = new Map<string, QuoteInput | null>();
    if (!dq.blocking) {
      for (const p of proposals) {
        if (p.proposal.kind !== 'allocation.swap') continue;
        try {
          const q = await d.quoter.quote({
            tokenIn: p.proposal.tokenIn,
            tokenOut: p.proposal.tokenOut,
            amountIn: p.proposal.amountIn,
          });
          quotes.set(p.proposalId, q);
        } catch (error) {
          quotes.set(p.proposalId, null);
          await this.record(
            'quote.failed',
            { proposalId: p.proposalId, error: errorMessage(error) },
            cycleKey,
            null,
            true,
          );
        }
      }
    }

    // 6. Decide (pure).
    state = await this.mode.current();
    const stillQuarantined = new Set<AgentId>(Object.keys(state.quarantined) as AgentId[]);
    const recent = await d.idempotency.recentActions(
      new Date(now.getTime() - cfg.execution.dedupeWindowSeconds * 1000),
    );
    const decision = decide({
      now,
      accountId: d.accountId,
      snapshot,
      market,
      dataQuality: dq,
      persistedMode: state.mode,
      proposals,
      quarantined: stillQuarantined,
      quotes,
      recentActions: recent,
      config: cfg,
    });
    await this.record(
      decision.outcome === 'act' ? 'decision.act' : 'decision.no_action',
      this.decisionPayload(decision, proposals, snapshot, market),
      cycleKey,
      decision.decisionId,
      true,
    );

    for (const a of decision.advisories) {
      await this.escalate(
        'info',
        'LP_ADVISORY',
        `position ${a.positionId}: re-centring to ticks [${a.tickLower}, ${a.tickUpper}] pays back in ~${a.paybackDays} days (estimate; advisory only)`,
        cycleKey,
        decision.decisionId,
        escalations,
      );
    }

    if (decision.outcome === 'no_action') {
      if (decision.wouldHaveActed) {
        await this.escalate(
          'info',
          'READ_ONLY_SUPPRESSED',
          `read-only mode suppressed: ${decision.wouldHaveActed.action.kind}`,
          cycleKey,
          decision.decisionId,
          escalations,
        );
      } else if (
        ['danger', 'critical', 'liquidatable'].includes(decision.risk.level) &&
        !decision.reasons.includes('DATA_NOT_FRESH')
      ) {
        await this.escalate(
          'page',
          'DERISK_UNAVAILABLE',
          `position risk is ${decision.risk.level} and no executable risk-reducing action is available`,
          cycleKey,
          decision.decisionId,
          escalations,
        );
      }
      const status = decision.reasons.includes('READ_ONLY_MODE') ? 'read_only' : 'no_action';
      return this.finish(
        cycleKey,
        status,
        `no action: ${decision.reasons.join(', ')}`,
        decision,
        [],
        null,
        escalations,
      );
    }

    // 7. Authorise and execute: first ranked candidate the policy engine accepts.
    const policySummaries: PolicyOutcomeSummary[] = [];
    for (const [rank, candidate] of decision.ranked.entries()) {
      const intent = candidateToIntent(candidate, decision.decisionId, rank);
      let plan;
      try {
        plan = await d.planner.plan(intent, d.accountId);
      } catch (error) {
        await this.record(
          'planning.failed',
          { proposalId: candidate.proposalId, error: errorMessage(error) },
          cycleKey,
          decision.decisionId,
          true,
        );
        continue;
      }
      const history = await d.history.stats(d.accountId, new Date(now.getTime() - DAY_MS));
      const verdict = d.policy.evaluate({ intent, plan, snapshot, history });
      policySummaries.push({
        intentId: intent.id,
        proposalId: candidate.proposalId,
        outcome: verdict.outcome,
        violations: verdict.violations.map((v) => ({
          rule: v.rule,
          message: v.message,
          severity: v.severity,
        })),
      });
      await this.record(
        'policy.verdict',
        {
          proposalId: candidate.proposalId,
          intentId: intent.id,
          outcome: verdict.outcome,
          violations: verdict.violations,
          valueUsdMicro: verdict.valueUsdMicro,
        },
        cycleKey,
        decision.decisionId,
        true,
      );

      if (verdict.outcome === 'reject') {
        if (candidate.tier <= 1) {
          await this.escalate(
            RANK_PAGE.has(decision.risk.level) ? 'page' : 'warn',
            'DERISK_BLOCKED_BY_POLICY',
            `policy rejected a risk-reducing action (${verdict.violations.map((v) => v.rule).join(', ')}) while position risk is ${decision.risk.level}; a human must act`,
            cycleKey,
            decision.decisionId,
            escalations,
          );
        }
        continue;
      }
      if (verdict.outcome === 'require_approval') {
        await d.idempotency.recordAction({
          actionKey: candidate.actionKey,
          kind: candidate.action.kind,
          decisionId: decision.decisionId,
          cycleKey,
          status: 'pending_approval',
          at: d.clock.now(),
          txHash: null,
        });
        await this.escalate(
          'warn',
          'APPROVAL_REQUIRED',
          `${candidate.action.kind} needs human approval (${verdict.violations.map((v) => v.rule).join(', ')})`,
          cycleKey,
          decision.decisionId,
          escalations,
        );
        return this.finish(
          cycleKey,
          'pending_approval',
          'policy requires human approval',
          decision,
          policySummaries,
          null,
          escalations,
        );
      }

      // Approved by policy. Before minting the ApprovedPlan, check that nothing has changed while we were busy.
      const recheck = await this.recheck(candidate, snapshot, market, cycleKey);
      if (recheck) {
        await this.record(
          'execution.aborted',
          { reason: recheck },
          cycleKey,
          decision.decisionId,
          true,
        );
        return this.finish(
          cycleKey,
          recheck.startsWith('read-only') ? 'read_only' : 'no_action',
          `aborted before execution: ${recheck}`,
          decision,
          policySummaries,
          null,
          escalations,
        );
      }

      const approved = d.policy.approve(plan, verdict);
      await this.record(
        'execution.started',
        {
          proposalId: candidate.proposalId,
          intentId: intent.id,
          planHash: approved.planHash,
          actionKey: candidate.actionKey,
        },
        cycleKey,
        decision.decisionId,
        true,
      );
      await d.idempotency.recordAction({
        actionKey: candidate.actionKey,
        kind: candidate.action.kind,
        decisionId: decision.decisionId,
        cycleKey,
        status: 'in_flight',
        at: d.clock.now(),
        txHash: null,
      });
      await d.idempotency.markExecutionStarted(cycleKey, candidate.actionKey);

      let result: ExecutionResult | null = null;
      let thrown: string | null = null;
      try {
        result = await this.executor.execute(approved);
      } catch (error) {
        thrown = errorMessage(error);
      }

      // Explicitly unknown, or a live failure without a transaction hash: it may or may not have reached the network.
      const inDoubt =
        thrown !== null ||
        result?.status === 'unknown' ||
        (result !== null &&
          result.mode === 'live' &&
          result.status === 'failed' &&
          result.txHash === null);
      if (inDoubt) {
        await this.safely(() =>
          this.record(
            'execution.in_doubt',
            { error: thrown ?? result?.error },
            cycleKey,
            decision.decisionId,
            false,
          ),
        );
        await d.idempotency.markNeedsReconciliation(cycleKey);
        await this.mode.tighten('read_only', `execution in doubt in cycle ${cycleKey}`);
        await this.escalate(
          'page',
          'IN_DOUBT_EXECUTION',
          `execution result unknown (${thrown ?? result?.error ?? 'no error'}); automation frozen until reconciled`,
          cycleKey,
          decision.decisionId,
          escalations,
        );
        return this.finish(
          cycleKey,
          'execution_in_doubt',
          'execution result unknown',
          decision,
          policySummaries,
          result,
          escalations,
          false,
        );
      }

      const ok = result?.status === 'success' || result?.status === 'dry_run';
      const status =
        result?.status === 'success'
          ? 'executed'
          : result?.status === 'dry_run'
            ? 'dry_run'
            : result?.status === 'rejected'
              ? 'rejected'
              : 'failed';
      await d.idempotency.updateAction(candidate.actionKey, decision.decisionId, {
        status,
        txHash: result?.txHash ?? null,
      });
      const recorded = await this.record(
        'execution.result',
        {
          status: result?.status,
          mode: result?.mode,
          txHash: result?.txHash ?? null,
          error: result?.error ?? null,
        },
        cycleKey,
        decision.decisionId,
        false,
      );
      if (!recorded) {
        await this.mode.tighten('read_only', 'audit log failed after an execution');
        await this.escalate(
          'page',
          'AUDIT_UNAVAILABLE',
          'could not record an execution result; automation frozen',
          cycleKey,
          decision.decisionId,
          escalations,
        );
      }
      const counters = await this.mode.recordExecution(ok);
      if (!ok) {
        await this.escalate(
          'warn',
          'EXECUTION_FAILED',
          `execution ${result?.status}: ${result?.error ?? 'unknown error'}`,
          cycleKey,
          decision.decisionId,
          escalations,
        );
        if (counters.consecutiveFailures >= cfg.execution.maxConsecutiveFailures) {
          await this.mode.tighten(
            'read_only',
            `${counters.consecutiveFailures} consecutive failed executions`,
          );
          await this.escalate(
            'page',
            'EMERGENCY_READ_ONLY',
            `${counters.consecutiveFailures} consecutive failed executions: read-only mode engaged`,
            cycleKey,
            decision.decisionId,
            escalations,
          );
        }
      }
      return this.finish(
        cycleKey,
        status === 'executed' ? 'executed' : status === 'dry_run' ? 'dry_run' : 'execution_failed',
        `execution ${result?.status}`,
        decision,
        policySummaries,
        result,
        escalations,
      );
    }

    return this.finish(
      cycleKey,
      'no_action',
      'no candidate could be planned and authorised',
      decision,
      policySummaries,
      null,
      escalations,
    );
  }

  /* ------------------------------ helpers ------------------------------ */

  /** Second look immediately before execution. Returns a reason to abort, or null. */
  private async recheck(
    candidate: Candidate,
    snapshot: PortfolioSnapshot,
    market: MarketContext | null,
    cycleKey: string,
  ): Promise<string | null> {
    const d = this.deps;
    const now = d.clock.now();
    const dq = checkDataQuality({
      now,
      expectedAccount: d.accountId,
      snapshot,
      market,
      config: d.config,
    });
    if (dq.blocking)
      return `data went stale during the cycle (${dq.issues
        .filter((i) => i.blocking)
        .map((i) => i.code)
        .join(', ')})`;
    const state = await this.mode.current();
    if (state.mode === 'read_only')
      return `read-only mode engaged during the cycle: ${state.reason}`;
    if (state.mode === 'risk_reduction_only' && candidate.tier === 2)
      return 'mode tightened to risk-reduction-only during the cycle';
    const recent = await d.idempotency.recentActions(
      new Date(now.getTime() - d.config.execution.dedupeWindowSeconds * 1000),
    );
    if (
      recent.some(
        (a) =>
          a.actionKey === candidate.actionKey &&
          (a.status === 'in_flight' || a.status === 'executed' || a.status === 'pending_approval'),
      )
    ) {
      return `duplicate action appeared during cycle ${cycleKey}`;
    }
    return null;
  }

  private decisionPayload(
    decision: Decision,
    proposals: readonly ParsedProposal[],
    snapshot: PortfolioSnapshot,
    market: MarketContext | null,
  ): Record<string, unknown> {
    const summary = (c: Candidate) => ({
      proposalId: c.proposalId,
      agent: c.agent,
      tier: c.tier,
      action: c.action,
      netBenefitUsdMicro: c.netBenefitUsdMicro,
      basis: c.basis,
      sizing: c.sizing,
      riskEffect: c.riskEffect,
      economics: c.economics,
    });
    return {
      outcome: decision.outcome,
      reasons: decision.reasons,
      inputsHash: decision.inputsHash,
      mode: decision.mode,
      risk: {
        level: decision.risk.level,
        healthFactorWad: decision.risk.healthFactorWad,
        ltvBps: decision.risk.ltvBps,
      },
      dataIssues: decision.dataQuality.issues,
      ranked: decision.ranked.map(summary),
      wouldHaveActed: decision.wouldHaveActed ? summary(decision.wouldHaveActed) : null,
      advisories: decision.advisories,
      rejected: decision.rejected,
      agentNoActions: decision.agentNoActions,
      cautions: decision.cautions,
      proposals: proposals.map((p) => ({
        proposalId: p.proposalId,
        agent: p.agent,
        kind: p.proposal.kind,
        rationale: excerpt(p.proposal.rationale),
      })),
      ...(this.deps.config.audit.storeInputs
        ? { inputs: { snapshot: toJsonSafe(snapshot), market: toJsonSafe(market) } }
        : {}),
    };
  }

  private bare(cycleKey: string, status: CycleStatus, detail: string): CycleReport {
    return {
      cycleKey,
      status,
      detail,
      decision: null,
      policy: [],
      execution: null,
      escalations: [],
      replayed: false,
    };
  }

  private async finishNoDecision(
    cycleKey: string,
    status: CycleStatus,
    detail: string,
    escalations: EscalationEvent[],
  ): Promise<CycleReport> {
    await this.deps.idempotency.complete(cycleKey, {
      outcome: status,
      decisionId: null,
      executed: false,
      detail,
    });
    return { ...this.bare(cycleKey, status, detail), escalations };
  }

  private async finish(
    cycleKey: string,
    status: CycleStatus,
    detail: string,
    decision: Decision,
    policy: readonly PolicyOutcomeSummary[],
    execution: ExecutionResult | null,
    escalations: EscalationEvent[],
    complete = true,
  ): Promise<CycleReport> {
    if (complete) {
      await this.deps.idempotency.complete(cycleKey, {
        outcome: status,
        decisionId: decision.decisionId,
        executed: status === 'executed',
        detail,
      });
    }
    await this.safely(() =>
      this.record('cycle.finished', { status, detail }, cycleKey, decision.decisionId, false),
    );
    return { cycleKey, status, detail, decision, policy, execution, escalations, replayed: false };
  }

  /**
   * Writes an audit entry. With `required`, a failure throws and aborts the cycle (nothing proceeds without a
   * record). Otherwise a failure is logged and `false` is returned.
   */
  private async record(
    type: string,
    payload: Record<string, unknown>,
    cycleKey: string | null,
    decisionId: string | null,
    required: boolean,
  ): Promise<boolean> {
    try {
      await this.deps.audit.append({
        at: this.deps.clock.now(),
        type,
        cycleKey,
        decisionId,
        payload,
      });
      return true;
    } catch (error) {
      if (required)
        throw new AuditUnavailableError(
          `audit log unavailable while recording ${type}: ${errorMessage(error)}`,
        );
      this.deps.logger.error('audit append failed', { type, error: errorMessage(error) });
      return false;
    }
  }

  private async escalate(
    severity: Severity,
    code: string,
    message: string,
    cycleKey: string | null,
    decisionId: string | null,
    sink?: EscalationEvent[],
  ): Promise<void> {
    const event: EscalationEvent = {
      severity,
      code,
      message,
      cycleKey,
      decisionId,
      at: this.deps.clock.now(),
    };
    sink?.push(event);
    await this.safely(() =>
      this.record('escalation', { severity, code, message }, cycleKey, decisionId, false),
    );
    try {
      await this.deps.notifier.notify(event);
    } catch (error) {
      this.deps.logger.error('notification failed', { code, error: errorMessage(error) });
      await this.safely(() =>
        this.record(
          'escalation.notify_failed',
          { code, error: errorMessage(error) },
          cycleKey,
          decisionId,
          false,
        ),
      );
    }
  }

  private async safely(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.deps.logger.error('best-effort step failed', { error: errorMessage(error) });
    }
  }
}

const RANK_PAGE = new Set(['danger', 'critical', 'liquidatable']);
