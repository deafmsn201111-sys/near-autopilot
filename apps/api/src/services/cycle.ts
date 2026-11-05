import { verdictRecord } from './verdicts';
import {
  AutopilotError,
  describeIntent,
  errorMessage,
  toJsonSafe,
  type AccountId,
  type ActionIntent,
  type Agent,
  type Clock,
  type ExecutionMode,
  type IdGenerator,
  type Logger,
  type PlanExecutor,
  type PortfolioSnapshot,
  type SwapQuoter,
} from '@near-autopilot/core';
import type { PolicyEngine } from '@near-autopilot/policy-engine';
import type { PlannerRegistry } from '@near-autopilot/tx-execution';
import { describeSnapshot } from './outcome';
import type { AutopilotRepository, ProposalRecord, RunRecord } from '../repository';

export class CycleInProgressError extends AutopilotError {
  constructor() {
    super('CYCLE_IN_PROGRESS', 'An autopilot cycle is already running');
  }
}

export interface CycleDeps {
  readonly accountId: AccountId;
  readonly executionMode: ExecutionMode;
  readonly agents: readonly Agent[];
  readonly quoter: SwapQuoter;
  readonly snapshots: { take(): Promise<PortfolioSnapshot> };
  readonly planners: PlannerRegistry;
  readonly policy: PolicyEngine;
  readonly executor: PlanExecutor;
  readonly repo: AutopilotRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

export interface CycleResult {
  readonly run: RunRecord;
  readonly proposals: readonly ProposalRecord[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * snapshot -> agents -> plan -> policy -> (execute) -> persist.
 * Agents are consulted in order; in live mode the cycle stops after the first transaction is sent
 * because the snapshot is stale from that point.
 */
export class AutopilotCycle {
  private running = false;

  constructor(private readonly deps: CycleDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(): Promise<CycleResult> {
    if (this.running) throw new CycleInProgressError();
    this.running = true;
    const { repo, clock, ids, accountId, logger } = this.deps;
    const runId = ids.next();
    const startedAt = clock.now();
    await repo.createRun({ id: runId, accountId, startedAt });
    const proposals: ProposalRecord[] = [];

    try {
      const snapshot = await this.deps.snapshots.take();
      let sent = false;

      for (const agent of this.deps.agents) {
        if (sent) break;
        let intents: readonly ActionIntent[];
        try {
          intents = await agent.evaluate({ snapshot, quoter: this.deps.quoter, clock, ids });
        } catch (error) {
          logger.error('agent failed', { agent: agent.id, error: errorMessage(error) });
          await repo.appendAudit({
            at: clock.now(),
            type: 'agent_error',
            runId,
            proposalId: null,
            payload: { agent: agent.id, error: errorMessage(error) },
          });
          continue;
        }
        for (const intent of intents) {
          const record = await this.process(runId, intent, snapshot);
          proposals.push(record);
          if (
            this.deps.executionMode === 'live' &&
            (record.status === 'executed' || record.status === 'failed') &&
            record.txHash !== null
          ) {
            sent = true;
            break;
          }
        }
      }

      const finishedAt = clock.now();
      const outcome = `${
        proposals.length === 0 ? 'no action proposed' : `${proposals.length} proposal(s)`
      }; ${describeSnapshot(snapshot)}`;
      await repo.finishRun(runId, {
        status: 'completed',
        finishedAt,
        error: null,
        outcome,
        snapshot: toJsonSafe(snapshot),
      });
      return {
        run: {
          id: runId,
          accountId,
          status: 'completed',
          startedAt,
          finishedAt,
          error: null,
          outcome,
        },
        proposals,
      };
    } catch (error) {
      const finishedAt = clock.now();
      const message = errorMessage(error);
      logger.error('cycle failed', { runId, error: message });
      await repo.finishRun(runId, {
        status: 'failed',
        finishedAt,
        error: message,
        outcome: null,
        snapshot: null,
      });
      return {
        run: {
          id: runId,
          accountId,
          status: 'failed',
          startedAt,
          finishedAt,
          error: message,
          outcome: null,
        },
        proposals,
      };
    } finally {
      this.running = false;
    }
  }

  private async process(
    runId: string,
    intent: ActionIntent,
    snapshot: PortfolioSnapshot,
  ): Promise<ProposalRecord> {
    const { repo, clock, planners, policy, executor, accountId, logger } = this.deps;
    const base = {
      id: intent.id,
      runId,
      accountId,
      agentId: intent.agentId,
      kind: intent.kind,
      summary: describeIntent(intent),
      reason: intent.reason,
      intent: toJsonSafe(intent),
      createdAt: clock.now(),
    };
    const finish = async (record: Omit<ProposalRecord, 'updatedAt'>): Promise<ProposalRecord> => {
      const full: ProposalRecord = { ...record, updatedAt: clock.now() };
      await repo.insertProposal(full);
      await repo.appendAudit({
        at: full.updatedAt,
        type: `proposal_${full.status}`,
        runId,
        proposalId: full.id,
        payload: { summary: full.summary, violations: full.violations, error: full.error },
      });
      logger.info('proposal resolved', {
        proposalId: full.id,
        status: full.status,
        kind: full.kind,
      });
      return full;
    };
    const empty = {
      valueUsdMicro: null,
      violations: [],
      planHash: null,
      executionMode: null,
      txHash: null,
      error: null,
    } as const;

    let plan;
    try {
      plan = await planners.plan(intent, accountId);
    } catch (error) {
      return finish({ ...base, ...empty, status: 'planning_failed', error: errorMessage(error) });
    }

    const history = await repo.getExecutionStats(
      accountId,
      new Date(clock.now().getTime() - DAY_MS),
    );
    const decision = policy.evaluate({ intent, plan, snapshot, history });
    // Every verdict is stored with its inputs BEFORE it is acted on; if that fails, nothing is executed.
    await repo.insertPolicyVerdict(
      verdictRecord(decision, { intent, plan, snapshot, history }, 'legacy', runId, policy.config),
    );
    const decided = {
      ...empty,
      valueUsdMicro: decision.valueUsdMicro,
      violations: decision.violations,
    };

    if (decision.outcome === 'reject') return finish({ ...base, ...decided, status: 'rejected' });
    if (decision.outcome === 'require_approval')
      return finish({ ...base, ...decided, status: 'requires_approval' });

    const approved = policy.approve(plan, decision);
    // Persist BEFORE executing: a crash mid-send must leave a visible 'approved' row, never nothing.
    await repo.insertProposal({
      ...base,
      ...decided,
      status: 'approved',
      planHash: approved.planHash,
      // Known before sending, so an `approved` row left by a crash mid-send still counts against live limits.
      executionMode: this.deps.executionMode,
      updatedAt: clock.now(),
    });
    await repo.appendAudit({
      at: clock.now(),
      type: 'proposal_approved',
      runId,
      proposalId: intent.id,
      payload: { planHash: approved.planHash, decisionId: decision.id },
    });

    const result = await executor.execute(approved);
    // `unknown` (signed, broadcast errored) is stored as `failed` WITH its tx hash: execution stats count such rows
    // against limits and cooldown, the cycle stops, and the error text says to reconcile it on-chain.
    const status: ProposalRecord['status'] =
      result.status === 'success' ? 'executed' : result.status === 'dry_run' ? 'dry_run' : 'failed';
    const patch = {
      status,
      executionMode: result.mode,
      txHash: result.txHash,
      error: result.error,
      updatedAt: clock.now(),
    };
    await repo.updateProposal(intent.id, patch);
    await repo.appendAudit({
      at: patch.updatedAt,
      type: `execution_${result.status}`,
      runId,
      proposalId: intent.id,
      payload: { mode: result.mode, txHash: result.txHash, error: result.error },
    });
    logger.info('proposal executed', { proposalId: intent.id, status, txHash: result.txHash });
    return { ...base, ...decided, planHash: approved.planHash, ...patch };
  }
}
