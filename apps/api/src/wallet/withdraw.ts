import type { AccountId, FunctionCallAction } from '@near-autopilot/core';
import type { CascadeStep } from './cascade';

/**
 * The NEAR side of a 1Click withdrawal (D36): one transaction on the token contract that registers the quote's
 * deposit address (an implicit account 1Click watches) when it holds no storage, then transfers the quoted amount to
 * it. Both actions share one receipt, so a failed registration sends nothing. Every value comes from the stored quote.
 */
export function buildWithdrawTransfer(o: {
  readonly token: AccountId;
  readonly receiver: string;
  readonly amount: bigint;
  /** 0 when the deposit address is already registered on the token. */
  readonly storageDeposit: bigint;
  readonly preview: string;
}): CascadeStep {
  const actions: FunctionCallAction[] = [];
  if (o.storageDeposit > 0n)
    actions.push({
      type: 'FunctionCall',
      methodName: 'storage_deposit',
      args: { account_id: o.receiver, registration_only: true },
      gas: 10_000_000_000_000n,
      deposit: o.storageDeposit,
    });
  actions.push({
    type: 'FunctionCall',
    methodName: 'ft_transfer',
    args: { receiver_id: o.receiver, amount: o.amount.toString() },
    gas: 30_000_000_000_000n,
    deposit: 1n,
  });
  return { intentId: 'withdraw', tx: { receiverId: o.token, actions }, preview: o.preview };
}
