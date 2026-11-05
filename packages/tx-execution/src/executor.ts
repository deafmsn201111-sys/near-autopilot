import {
  errorMessage,
  type ApprovalAuthority,
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
import { refuseUnsafeKey } from './key-guard';

export interface TransactionExecutorDeps {
  readonly signer: TransactionSigner;
  readonly contextProvider: ChainContextProvider;
  readonly broadcaster: TransactionBroadcaster;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The policy engine that minted the approvals this executor may run. */
  readonly approvals: ApprovalAuthority;
  /**
   * Decides whether the signing key may sign this plan. Default `refuseUnsafeKey` (full-access keys are refused).
   * Overridden only by tests that exercise pipeline mechanics, never in wiring.
   */
  readonly keyGuard?: typeof refuseUnsafeKey;
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
 * It only accepts `ApprovedPlan` (compile time) that its `ApprovalAuthority` recognises (run time).
 */
export class TransactionExecutor implements PlanExecutor {
  private readonly replay = new ReplayGuard();

  constructor(private readonly deps: TransactionExecutorDeps) {}

  async execute(approved: ApprovedPlan): Promise<ExecutionResult> {
    const { signer, contextProvider, broadcaster, clock, logger, approvals } = this.deps;
    try {
      verifyApproval(approved, clock.now(), approvals);
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

    // Once signed, the hash identifies the transaction whether or not the broadcast call returns cleanly.
    let signedHash: string | null = null;
    try {
      const chain = await contextProvider.getContext(signer.accountId, signer.publicKey);
      // The key's permission comes from the same chain query as the nonce: checked on every transaction, before signing.
      const refusal = (this.deps.keyGuard ?? refuseUnsafeKey)(chain.permission, approved.plan);
      if (refusal) {
        logger.warn('signing refused: unsafe key', { intentId: approved.plan.intentId, refusal });
        return rejected('live', refusal);
      }
      const signed = await signer.sign(approved.plan, chain);
      signedHash = signed.hash;
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
        txHash: signedHash,
        error: errorMessage(error),
      });
      // Failed before signing: nothing can have reached the network.
      if (signedHash === null) {
        return { status: 'failed', mode: 'live', txHash: null, error: errorMessage(error) };
      }
      // Signed and handed to the broadcaster, which errored: the transaction may still land. Keep its hash so the
      // caller stops, counts it against limits and cooldown, and an operator can reconcile it on-chain.
      return {
        status: 'unknown',
        mode: 'live',
        txHash: signedHash,
        error: `outcome unknown, reconcile ${signedHash} on-chain: ${errorMessage(error)}`,
      };
    }
  }
}

/**
 * Explicit no-send executor. It performs the same approval verification as the live executor but
 * never signs or broadcasts, and reports `dry_run` so nothing downstream mistakes it for a fill.
 */
export class DryRunExecutor implements PlanExecutor {
  private readonly replay = new ReplayGuard();

  constructor(
    private readonly deps: Pick<TransactionExecutorDeps, 'clock' | 'logger' | 'approvals'>,
  ) {}

  async execute(approved: ApprovedPlan): Promise<ExecutionResult> {
    try {
      verifyApproval(approved, this.deps.clock.now(), this.deps.approvals);
    } catch (error) {
      return rejected('dry-run', errorMessage(error));
    }
    if (!this.replay.claim(approved)) return rejected('dry-run', 'Approval has already been used');
    this.deps.logger.info('dry-run: would execute transaction', {
      intentId: approved.plan.intentId,
      receiverId: approved.plan.receiverId,
      methods: approved.plan.actions.map((a) => a.methodName),
    });
    return { status: 'dry_run', mode: 'dry-run', txHash: null, error: null };
  }
}
