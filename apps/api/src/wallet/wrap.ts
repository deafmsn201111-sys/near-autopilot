import type { AccountId, FunctionCallAction } from '@near-autopilot/core';

/**
 * Pure builders for wrapping and unwrapping NEAR on the canonical wrapped-NEAR contract (wrap.near).
 * Wrapped NEAR is an ordinary NEP-141 token backed 1:1 by native NEAR (spec ft-1.0.0, "Wrapped NEAR fungible
 * token"); `near_deposit` mints wNEAR from the attached NEAR, `near_withdraw { amount }` burns wNEAR back to native
 * NEAR. `near_withdraw` is `#[payable]` and asserts exactly one yoctoNEAR. These never sign and never hold keys.
 */

export interface BuiltWrapTransaction {
  readonly receiverId: AccountId;
  readonly actions: readonly FunctionCallAction[];
}

/** Gas for a near_deposit / near_withdraw call (light; standard 10 Tgas suffices). */
export const WRAP_GAS = 10_000_000_000_000n;

/** Unwrap `rawAmount` wNEAR (raw 24-decimal units) back to native NEAR. One yoctoNEAR is attached as required. */
export function buildUnwrapNear(args: {
  readonly wrapContractId: AccountId;
  readonly rawAmount: bigint;
}): BuiltWrapTransaction {
  if (args.rawAmount <= 0n) throw new RangeError('unwrap amount must be positive');
  return {
    receiverId: args.wrapContractId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'near_withdraw',
        args: { amount: args.rawAmount.toString() },
        gas: WRAP_GAS,
        deposit: 1n,
      },
    ],
  };
}

/** Wrap `rawAmount` native NEAR (yoctoNEAR) into wNEAR by attaching it to `near_deposit`. */
export function buildWrapNear(args: {
  readonly wrapContractId: AccountId;
  readonly rawAmount: bigint;
}): BuiltWrapTransaction {
  if (args.rawAmount <= 0n) throw new RangeError('wrap amount must be positive');
  return {
    receiverId: args.wrapContractId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'near_deposit',
        args: {},
        gas: WRAP_GAS,
        deposit: args.rawAmount,
      },
    ],
  };
}
