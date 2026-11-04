import type { AccountId, FunctionCallAction, Network } from '@near-autopilot/core';
import { BURROW_GAS } from './constants';
import { rawToInner } from './units';
import {
  assertTokenFresh,
  BurrowVerificationError,
  type VerifiedBurrowDeployment,
  type VerifiedBurrowToken,
} from './verify';

/**
 * Pure transaction builders for the two risk-REDUCING Burrow actions: repay, and increase collateral.
 * Borrow and withdraw are intentionally absent (they raise risk and also need priced `oracle_call` flows).
 *
 * Every builder demands a `VerifiedBurrowDeployment` and `VerifiedBurrowToken`. Those can only be minted by
 * `BurrowVerifier`, which has checked the chain id, the code actually deployed at each receiver, the oracle
 * Burrow trusts, and that the token is listed and accepted. Builders never sign and never touch keys.
 *
 * Interfaces (S = contract source, A = burrow-cash frontend):
 *   ft_transfer_call on the token -> ft_on_transfer on Burrow; empty `msg` = plain deposit;
 *   `msg = {"Execute":{"actions":[...]}}` runs actions after depositing (S fungible_token.rs).
 *   Action::Repay(AssetAmount) / Action::IncreaseCollateral(AssetAmount), AssetAmount = { token_id, amount?,
 *   max_amount? } in INNER units (S actions.rs). Repay with `max_amount` is capped at that amount (S
 *   asset_amount_to_shares). A: repay.ts, supply.ts, adjustCollateral.ts use exactly these shapes.
 */

export interface BuiltBurrowTransaction {
  readonly network: Network;
  readonly receiverId: AccountId;
  readonly actions: readonly FunctionCallAction[];
}

interface Common {
  readonly deployment: VerifiedBurrowDeployment;
  readonly token: VerifiedBurrowToken;
  /** Current time; verification proofs older than their expiry are rejected. */
  readonly now: Date;
}

/** Proof freshness and origin first, then whether the proof's purpose covers this operation. */
function guard(
  c: Common,
  allowed: ReadonlyArray<VerifiedBurrowToken['purpose']>,
  what: string,
): void {
  assertTokenFresh(c.token, c.deployment, c.now);
  if (!allowed.includes(c.token.purpose)) {
    throw new BurrowVerificationError(
      'TOKEN_NOT_ACCEPTED',
      `${c.token.tokenId} was verified for "${c.token.purpose}", which does not cover ${what}`,
    );
  }
}

function transferCall(c: Common, rawAmount: bigint, msg: string): BuiltBurrowTransaction {
  if (rawAmount <= 0n) throw new RangeError('amount must be positive');
  return {
    network: c.deployment.network,
    receiverId: c.token.tokenId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: c.deployment.contractId, amount: rawAmount.toString(), msg },
        gas: BURROW_GAS.ftTransferCall,
        deposit: 1n,
      },
    ],
  };
}

/**
 * Repay debt from the wallet. `rawAmount` is in raw token units and is both transferred and used as the
 * repay cap (`max_amount`, inner units), so the call can never repay more than was sent. If the debt is
 * smaller than `rawAmount`, the surplus stays in the account as a supplied (non-collateral) balance.
 * The token must have been verified with purpose `repay`, `supply` or `collateral`.
 */
export function buildRepay(args: Common & { readonly rawAmount: bigint }): BuiltBurrowTransaction {
  guard(args, ['repay', 'supply', 'collateral'], 'repay');
  const msg = JSON.stringify({
    Execute: {
      actions: [
        {
          Repay: {
            token_id: args.token.tokenId,
            max_amount: rawToInner(args.rawAmount, args.token.extraDecimals).toString(),
          },
        },
      ],
    },
  });
  return transferCall(args, args.rawAmount, msg);
}

/**
 * Deposit from the wallet and mark it as collateral in the same transaction (A: supply.ts with
 * `useAsCollateral`). The token must have been verified with purpose `collateral`.
 */
export function buildSupplyAsCollateral(
  args: Common & { readonly rawAmount: bigint },
): BuiltBurrowTransaction {
  guard(args, ['collateral'], 'increasing collateral');
  const msg = JSON.stringify({
    Execute: {
      actions: [
        {
          IncreaseCollateral: {
            token_id: args.token.tokenId,
            max_amount: rawToInner(args.rawAmount, args.token.extraDecimals).toString(),
          },
        },
      ],
    },
  });
  return transferCall(args, args.rawAmount, msg);
}

/** Plain deposit with no collateral flag: empty `msg` (S: ft_on_transfer; A: supply.ts). */
export function buildSupply(args: Common & { readonly rawAmount: bigint }): BuiltBurrowTransaction {
  guard(args, ['supply', 'collateral'], 'supply');
  return transferCall(args, args.rawAmount, '');
}

/**
 * Promote already-supplied (non-collateral) balance to collateral: `execute` on Burrow itself with 1 yocto
 * (S: actions.rs `execute`, `#[payable]`, `assert_one_yocto`; A: adjustCollateral.ts). `innerAmount` is in
 * Burrow INNER units exactly as `get_account` reports them; omit it to move the entire supplied balance.
 * The caller (the signer) must already be registered with Burrow, or the contract panics.
 */
export function buildIncreaseCollateralFromSupplied(
  args: Common & { readonly innerAmount?: bigint },
): BuiltBurrowTransaction {
  guard(args, ['collateral'], 'increasing collateral');
  if (args.innerAmount !== undefined && args.innerAmount <= 0n)
    throw new RangeError('innerAmount must be positive');
  const assetAmount: Record<string, unknown> = { token_id: args.token.tokenId };
  if (args.innerAmount !== undefined) assetAmount['max_amount'] = args.innerAmount.toString();
  return {
    network: args.deployment.network,
    receiverId: args.deployment.contractId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'execute',
        args: { actions: [{ IncreaseCollateral: assetAmount }] },
        gas: BURROW_GAS.execute,
        deposit: 1n,
      },
    ],
  };
}
