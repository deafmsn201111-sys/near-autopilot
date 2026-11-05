import type {
  AccessKeyPermission,
  AccountId,
  ChainContext,
  PlannedTransaction,
} from '@near-autopilot/core';

/**
 * KEY GUARD: the autopilot never signs with a key that could do more than the transaction in hand.
 *
 *   full_access     REFUSED, always. A full-access key can add keys, deploy code, transfer every token and delete the
 *                   account; a compromised or misbehaving autopilot holding one has no ceiling.
 *   function_call   allowed only for exactly this transaction: same receiver, an allowed method, NO attached deposit.
 *                   (The NEAR runtime itself rejects a function-call key on a call with a deposit; refusing first
 *                   gives a clear reason instead of a failed receipt.)
 *
 * Consequence, stated plainly: every plan the planners build today is an `ft_transfer_call`, which NEP-141 requires to
 * carry exactly 1 yoctoNEAR. No such plan can be signed autonomously under this guard. Live autonomous execution needs
 * a custody design that does not hand the autopilot a full-access key (e.g. an MPC / delegated signer with its own
 * limits); until then the autopilot runs dry-run, which is how every deployment of this repository runs.
 *
 * Returns the reason to refuse, or null.
 */
export function refuseUnsafeKey(
  permission: AccessKeyPermission,
  plan: PlannedTransaction,
): string | null {
  if (permission.kind === 'full_access')
    return 'FULL_ACCESS_KEY_REFUSED: the signing key is a full-access key; the autopilot signs only with a function-call key scoped to the transaction';
  if (permission.receiverId !== plan.receiverId)
    return `FUNCTION_CALL_KEY_SCOPE: the key is for ${permission.receiverId}, the transaction is for ${plan.receiverId}`;
  for (const a of plan.actions) {
    if (permission.methodNames.length > 0 && !permission.methodNames.includes(a.methodName))
      return `FUNCTION_CALL_KEY_SCOPE: the key does not allow ${a.methodName}`;
    if (a.deposit > 0n)
      return `FUNCTION_CALL_KEY_DEPOSIT: ${a.methodName} attaches ${a.deposit} yoctoNEAR; a function-call key cannot attach a deposit`;
  }
  return null;
}

/** Start-up check for live mode: a full-access signing key stops the process before any cycle runs. */
export async function assertNotFullAccessKey(
  contextProvider: { getContext(signerId: AccountId, publicKey: string): Promise<ChainContext> },
  signer: { readonly accountId: AccountId; readonly publicKey: string },
): Promise<void> {
  const { permission } = await contextProvider.getContext(signer.accountId, signer.publicKey);
  if (permission.kind === 'full_access')
    throw new Error(
      `FULL_ACCESS_KEY_REFUSED: ${signer.publicKey} is a full-access key of ${signer.accountId}; the autopilot refuses to run live with it`,
    );
}
