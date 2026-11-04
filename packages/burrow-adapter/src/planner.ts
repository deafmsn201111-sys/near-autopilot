import type {
  AccountId,
  ActionIntent,
  Clock,
  PlannedTransaction,
  ProtocolPlanner,
} from '@near-autopilot/core';
import { PreconditionError, UnsupportedIntentError } from '@near-autopilot/core';
import {
  buildRepay,
  buildSupply,
  buildSupplyAsCollateral,
  type BuiltBurrowTransaction,
} from './builders';
import type { BurrowClient } from './client';
import type { BurrowVerifier } from './verify';

export interface BurrowPlannerOptions {
  readonly verifier: BurrowVerifier;
  readonly client: BurrowClient;
  readonly clock: Clock;
}

/**
 * Plans the two risk-reducing Burrow intents (repay, supply [as collateral]). Before any transaction is built
 * the deployment and the token are verified on-chain (see `BurrowVerifier`), and the signer must be registered
 * with Burrow (an unregistered account makes `ft_on_transfer` panic and the transfer bounce).
 * Intentionally no borrow or withdraw.
 */
export class BurrowPlanner implements ProtocolPlanner {
  readonly protocol = 'burrow' as const;

  constructor(private readonly options: BurrowPlannerOptions) {}

  supports(intent: ActionIntent): boolean {
    return intent.kind === 'lending.repay' || intent.kind === 'lending.supply';
  }

  async plan(intent: ActionIntent, signerId: AccountId): Promise<PlannedTransaction> {
    if (intent.kind !== 'lending.repay' && intent.kind !== 'lending.supply')
      throw new UnsupportedIntentError(intent.kind);
    const { verifier, client, clock } = this.options;

    const deployment = await verifier.verifyDeployment();
    const account = await client.getAccount(signerId);
    if (!account) {
      throw new PreconditionError(
        `${signerId} is not registered with Burrow (${deployment.contractId}); register it before sending tokens`,
      );
    }

    let built: BuiltBurrowTransaction;
    if (intent.kind === 'lending.repay') {
      const hasDebt = account.borrowed.some((b) => b.tokenId === intent.token && b.inner > 0n);
      if (!hasDebt)
        throw new PreconditionError(`${signerId} has no ${intent.token} debt on Burrow to repay`);
      const token = await verifier.verifyToken(deployment, intent.token, 'repay');
      built = buildRepay({ deployment, token, now: clock.now(), rawAmount: intent.amount });
    } else if (intent.asCollateral) {
      const token = await verifier.verifyToken(deployment, intent.token, 'collateral');
      built = buildSupplyAsCollateral({
        deployment,
        token,
        now: clock.now(),
        rawAmount: intent.amount,
      });
    } else {
      const token = await verifier.verifyToken(deployment, intent.token, 'supply');
      built = buildSupply({ deployment, token, now: clock.now(), rawAmount: intent.amount });
    }

    return { intentId: intent.id, signerId, receiverId: built.receiverId, actions: built.actions };
  }
}
