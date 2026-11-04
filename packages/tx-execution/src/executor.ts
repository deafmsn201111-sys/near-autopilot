import {
  errorMessage,
  type ApprovedPlan,
  type ChainContextProvider,
  type Clock,
  type ExecutionResult,
  type Logger,
  type PlanExecutor,
  type TransactionBroadcaster,
  type TransactionSigner,
} from '@near-autopilot/core';
import { verifyApproval } from './approval';

export interface TransactionExecutorDeps {
  readonly signer: TransactionSigner;
  readonly contextProvider: ChainContextProvider;
  readonly broadcaster: TransactionBroadcaster;
  readonly clock: Clock;
  readonly logger: Logger;
}

const rejected = (mode: ExecutionResult['mode'], error: string): ExecutionResult => ({
  status: 'rejected',
  mode,
  txHash: null,
  error,
});

/** Tracks which approvals were already used so an approval can never be replayed. */
class ReplayGuard {
  private readonly used = new Set<string>();
  claim(approved: ApprovedPlan): boolean {
    const key = `${approved.decisionId}:${approved.planHash}`;
    if (this.used.has(key)) return false;
    this.used.add(key);
    return true;
  }
}

/**
 * Live executor: verify approval -> fetch nonce/block hash -> sign -> broadcast.
 * It only accepts `ApprovedPlan`, so nothing that skipped the policy engine type-checks.
 */
export class TransactionExecutor implements PlanExecutor {
  private readonly replay = new ReplayGuard();

  constructor(private readonly deps: TransactionExecutorDeps) {}

  async execute(approved: ApprovedPlan): Promise<ExecutionResult> {
    const { signer, contextProvider, broadcaster, clock, logger } = this.deps;
    try {
      verifyApproval(approved, clock.now());
    } catch (error) {
      return rejected('live', errorMessage(error));
    }
    if (approved.plan.signerId !== signer.accountId) {
      return rejected(
        'live',
        `Plan signer ${approved.plan.signerId} does not match configured signer ${signer.accountId}`,
      );
    }
    if (!this.replay.claim(approved)) return rejected('live', 'Approval has already been used');

    try {
      const chain = await contextProvider.getContext(signer.accountId, signer.publicKey);
      const signed = await signer.sign(approved.plan, chain);
      logger.info('broadcasting transaction', {
        intentId: approved.plan.intentId,
        txHash: signed.hash,
      });
      const result = await broadcaster.broadcast(signed, signer.accountId);
      return {
        status: result.status === 'success' ? 'success' : 'failed',
        mode: 'live',
        txHash: result.txHash,
        error: result.failureReason,
      };
    } catch (error) {
      logger.error('execution failed', {
        intentId: approved.plan.intentId,
        error: errorMessage(error),
      });
      return { status: 'failed', mode: 'live', txHash: null, error: errorMessage(error) };
    }
  }
}

/**
 * Explicit no-send executor. It performs the same approval verification as the live executor but
 * never signs or broadcasts, and reports `dry_run` so nothing downstream mistakes it for a fill.
 */
export class DryRunExecutor implements PlanExecutor {
  constructor(private readonly deps: Pick<TransactionExecutorDeps, 'clock' | 'logger'>) {}

  async execute(approved: ApprovedPlan): Promise<ExecutionResult> {
    try {
      verifyApproval(approved, this.deps.clock.now());
    } catch (error) {
      return rejected('dry-run', errorMessage(error));
    }
    this.deps.logger.info('dry-run: would execute transaction', {
      intentId: approved.plan.intentId,
      receiverId: approved.plan.receiverId,
      methods: approved.plan.actions.map((a) => a.methodName),
    });
    return { status: 'dry_run', mode: 'dry-run', txHash: null, error: null };
  }
}
