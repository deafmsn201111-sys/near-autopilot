import type {
  AccountId,
  ActionIntent,
  Clock,
  IdGenerator,
  Logger,
  PlanExecutor,
  PlannedTransaction,
  PolicyDecision,
  PortfolioSnapshot,
  TokenId,
} from '@near-autopilot/core';
import { usdToMicro } from '@near-autopilot/core';
import { rawForValueUsd } from '@near-autopilot/financial-engine';
import type { PolicyEngine } from '@near-autopilot/policy-engine';
import type { AutopilotRepository } from '../repository';
import { verdictRecord } from './verdicts';

/**
 * "LET THE AGENT DO IT": a user asks the autopilot to carry out one action (deposit idle tokens into Burrow, or repay
 * the loan). The request goes through EXACTLY the pipeline the agents' own proposals go through:
 *
 *   intent -> planner (Burrow verifier) -> policy engine (12 checks; verdict stored first) -> executor
 *
 * - ALLOW            the plan is approved by the engine and handed to the executor (dry-run: the Shadow Gateway).
 * - REQUIRE APPROVAL the plan waits for the user's confirmation (approveByOperator: same plan, once, within the
 *                    approval TTL, named approver). This is the "confirm every transaction" mode.
 * - BLOCK            nothing happens; the reasons are returned. No confirmation can override a rejection.
 *
 * The executor is the one the deployment was wired with; in this project that is never a mainnet signer.
 */
export type RequestKind = 'supply' | 'repay';

export interface RequestInput {
  readonly kind: RequestKind;
  readonly token: TokenId;
  readonly usd: number;
  readonly by: string;
}

export interface RequestResult {
  readonly id: string;
  readonly status: 'done' | 'blocked' | 'needs_approval' | 'failed';
  readonly verdict: string | null;
  readonly valueUsd: number | null;
  readonly sentence: string;
  readonly reasons: readonly string[];
  readonly mode: 'dry-run' | 'live' | null;
  readonly txHash: string | null;
  readonly expiresAt: string | null;
}

interface Pending {
  readonly intent: ActionIntent;
  readonly plan: PlannedTransaction;
  readonly decision: PolicyDecision;
  readonly expiresAt: Date;
}

export interface RequestDeps {
  readonly policy: PolicyEngine;
  readonly planners: {
    plan(intent: ActionIntent, signerId: AccountId): Promise<PlannedTransaction>;
  };
  readonly executor: PlanExecutor;
  readonly snapshots: { take(): Promise<PortfolioSnapshot> };
  readonly repo: Pick<
    AutopilotRepository,
    'insertPolicyVerdict' | 'appendAudit' | 'getExecutionStats'
  >;
  readonly accountId: AccountId;
  /** Which demo portfolio this service acts for (recorded with every audit entry, for the Activity page). */
  readonly portfolio?: string;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
}

const DAY_MS = 86_400_000;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class UserRequestService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: RequestDeps) {}

  async request(input: RequestInput): Promise<RequestResult> {
    const d = this.d;
    const id = `req-${d.ids.next()}`;
    if (!input.by.trim()) throw new RangeError('a request needs a named requester');
    if (!(input.usd > 0) || input.usd > 1_000_000)
      throw new RangeError('the amount must be a positive USD value');
    const snapshot = await d.snapshots.take();
    const price = snapshot.prices.get(input.token);
    if (!price)
      return this.fail(
        id,
        `no confirmed price for ${input.token}: nothing can be valued, nothing is done`,
      );
    const amount = rawForValueUsd(usdToMicro(input.usd), price);
    if (amount <= 0n) return this.fail(id, 'the amount is too small');
    const base = {
      id,
      agentId: `operator/${input.by}`,
      reason: `requested by ${input.by} from the dashboard`,
    };
    const intent: ActionIntent =
      input.kind === 'supply'
        ? {
            ...base,
            kind: 'lending.supply',
            protocol: 'burrow',
            token: input.token,
            amount,
            asCollateral: false,
          }
        : { ...base, kind: 'lending.repay', protocol: 'burrow', token: input.token, amount };

    let plan: PlannedTransaction;
    try {
      plan = await d.planners.plan(intent, d.accountId);
    } catch (e) {
      return this.fail(id, `could not plan it: ${errorText(e)}`);
    }
    const history = await d.repo.getExecutionStats(
      d.accountId,
      new Date(d.clock.now().getTime() - DAY_MS),
    );
    const decision = d.policy.evaluate({ intent, plan, snapshot, history });
    // Stored BEFORE anything is acted on, like every verdict.
    await d.repo.insertPolicyVerdict(
      verdictRecord(
        decision,
        { intent, plan, snapshot, history },
        'legacy',
        `request:${id}`,
        d.policy.config,
      ),
    );
    await this.audit('operator.request', id, {
      kind: intent.kind,
      token: input.token,
      usd: input.usd,
      by: input.by,
      verdict: decision.verdict,
      outcome: decision.outcome,
    });
    const valueUsd = decision.valueUsdMicro === null ? null : Number(decision.valueUsdMicro) / 1e6;
    const reasons = decision.violations.map((v) => v.message);
    if (decision.outcome === 'reject')
      return {
        id,
        status: 'blocked',
        verdict: decision.verdict,
        valueUsd,
        sentence:
          'Blocked by the safety policy. Nothing was done, and no confirmation can override it.',
        reasons,
        mode: null,
        txHash: null,
        expiresAt: null,
      };
    if (decision.outcome === 'require_approval') {
      const expiresAt = new Date(
        decision.evaluatedAt.getTime() + d.policy.config.approvalTtlSeconds * 1000,
      );
      this.pending.set(id, { intent, plan, decision, expiresAt });
      return {
        id,
        status: 'needs_approval',
        verdict: decision.verdict,
        valueUsd,
        sentence: 'The safety policy allows it only with your confirmation.',
        reasons,
        mode: null,
        txHash: null,
        expiresAt: expiresAt.toISOString(),
      };
    }
    return this.execute(id, plan, decision, null, valueUsd);
  }

  async confirm(id: string, by: string): Promise<RequestResult> {
    const p = this.pending.get(id);
    if (!p)
      return this.fail(
        id,
        'nothing is waiting for confirmation under this id (it expired or was already used)',
      );
    this.pending.delete(id);
    if (this.d.clock.now() > p.expiresAt)
      return this.fail(id, 'the confirmation window expired; ask again');
    const valueUsd =
      p.decision.valueUsdMicro === null ? null : Number(p.decision.valueUsdMicro) / 1e6;
    return this.execute(id, p.plan, p.decision, by, valueUsd);
  }

  private async execute(
    id: string,
    plan: PlannedTransaction,
    decision: PolicyDecision,
    confirmedBy: string | null,
    valueUsd: number | null,
  ): Promise<RequestResult> {
    const approved = confirmedBy
      ? this.d.policy.approveByOperator(plan, decision, confirmedBy)
      : this.d.policy.approve(plan, decision);
    const result = await this.d.executor.execute(approved);
    await this.audit('operator.request.result', id, {
      confirmedBy,
      status: result.status,
      mode: result.mode,
      txHash: result.txHash,
      error: result.error,
    });
    this.d.logger.info('operator request executed', {
      id,
      status: result.status,
      mode: result.mode,
    });
    const ok = result.status === 'dry_run' || result.status === 'success';
    return {
      id,
      status: ok ? 'done' : 'failed',
      verdict: decision.verdict,
      valueUsd,
      sentence:
        result.status === 'dry_run'
          ? 'Done as a dry run: the plan passed every check and was simulated. Nothing was signed or sent.'
          : result.status === 'success'
            ? 'Done.'
            : `The executor refused it: ${result.error ?? result.status}`,
      reasons: [],
      mode: result.mode,
      txHash: result.txHash,
      expiresAt: null,
    };
  }

  private async fail(id: string, sentence: string): Promise<RequestResult> {
    await this.audit('operator.request.failed', id, { sentence });
    return {
      id,
      status: 'failed',
      verdict: null,
      valueUsd: null,
      sentence,
      reasons: [],
      mode: null,
      txHash: null,
      expiresAt: null,
    };
  }

  private audit(type: string, id: string, payload: Record<string, unknown>) {
    return this.d.repo.appendAudit({
      at: this.d.clock.now(),
      type,
      runId: `request:${id}`,
      proposalId: null,
      payload: { ...payload, portfolio: this.d.portfolio ?? null },
    });
  }
}
