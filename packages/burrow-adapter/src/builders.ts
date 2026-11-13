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
 * Pure transaction builders for Burrow actions. The risk-REDUCING ones (repay, increase collateral, supply) send
 * `ft_transfer_call` to the token. The liquidity-changing ones (borrow, withdraw) must be PRICED: they go through
 * the verified oracle's `oracle_call`, which pushes fresh prices into Burrow's `oracle_on_call` so the contract
 * re-checks that collateral still covers debt before running the action (S: price_receiver.rs, actions.rs).
 *
 * Every builder demands a `VerifiedBurrowDeployment` and `VerifiedBurrowToken`. Those can only be minted by
 * `BurrowVerifier`, which has checked the chain id, the code actually deployed at each receiver, the oracle
 * Burrow trusts (and its code), and that the token is listed and accepted FOR THIS PURPOSE. Builders never sign
 * and never touch keys.
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
 * Build an `oracle_call` on the VERIFIED oracle that forwards a priced `Execute { actions }` to Burrow. `assetIds`
 * are the price feeds Burrow needs to value the account (its collateral + borrowed assets + the action token); the
 * caller resolves them on-chain. Attaches exactly one yoctoNEAR, as the oracle asserts (S: price-oracle lib.rs).
 */
function oracleExecute(
  deployment: VerifiedBurrowDeployment,
  actions: readonly Record<string, unknown>[],
  assetIds: readonly string[],
): BuiltBurrowTransaction {
  if (assetIds.length === 0) throw new RangeError('assetIds must not be empty');
  const msg = JSON.stringify({ Execute: { actions } });
  return {
    network: deployment.network,
    receiverId: deployment.oracleId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'oracle_call',
        args: { receiver_id: deployment.contractId, asset_ids: [...assetIds], msg },
        gas: BURROW_GAS.oracleCall,
        deposit: 1n,
      },
    ],
  };
}

/**
 * Borrow `rawAmount` of the token and send it to the wallet. Priced through the oracle: Burrow checks collateral
 * covers the new debt at fresh prices or the call reverts. A `Borrow` only credits the account's supplied balance
 * (S: internal_borrow), so it is paired with a `Withdraw` of the same amount to move the tokens to the wallet.
 * The token must have been verified with purpose `borrow` (asset `can_borrow`). `assetIds` must cover every asset
 * Burrow values for this account (resolved on-chain by the caller).
 */
export function buildBorrow(
  args: Common & { readonly rawAmount: bigint; readonly assetIds: readonly string[] },
): BuiltBurrowTransaction {
  guard(args, ['borrow'], 'borrow');
  if (args.rawAmount <= 0n) throw new RangeError('amount must be positive');
  const inner = rawToInner(args.rawAmount, args.token.extraDecimals).toString();
  return oracleExecute(
    args.deployment,
    [
      { Borrow: { token_id: args.token.tokenId, amount: inner } },
      { Withdraw: { token_id: args.token.tokenId, max_amount: inner } },
    ],
    args.assetIds,
  );
}

/**
 * Withdraw up to `rawAmount` of a supplied (or collateral) balance to the wallet. Burrow's `Withdraw` only draws on
 * the plain supplied balance, so `fromCollateralRaw` first moves that much collateral back to it with
 * `DecreaseCollateral` (A: withdraw.ts). Priced through the oracle so that, if the account also has debt, Burrow
 * verifies the remaining collateral still covers it or the call reverts; with no debt it simply returns the funds.
 * `max_amount` caps each action at what is there. The token must have been verified with purpose `withdraw`
 * (asset `can_withdraw`). `assetIds` must cover every asset Burrow values for this account.
 */
export function buildWithdraw(
  args: Common & {
    readonly rawAmount: bigint;
    readonly fromCollateralRaw?: bigint;
    readonly assetIds: readonly string[];
  },
): BuiltBurrowTransaction {
  guard(args, ['withdraw'], 'withdraw');
  return oracleExecute(
    args.deployment,
    withCollateralRelease(args, args.fromCollateralRaw ?? 0n, 'Withdraw'),
    args.assetIds,
  );
}

/**
 * Repay debt from the account's own Burrow balance of the SAME token, without the wallet holding it: an optional
 * `DecreaseCollateral` of `fromCollateralRaw` moves collateral to the supplied balance, then `Repay` (capped at
 * `rawAmount` and at the debt) pays from that balance (S: actions.rs internal_repay; A: repayFromDeposits.ts). The
 * part of `rawAmount` above `fromCollateralRaw` comes from plain supply, which counts for nothing in the health
 * factor. Collateral and debt fall by the same amount while collateral covers the debt, so the health factor only
 * rises; Burrow still re-checks it at fresh oracle prices. Decreased collateral the debt did not need stays as
 * supply. The token must have been verified with purpose `repay`, `supply` or `collateral`.
 */
export function buildRepayFromCollateral(
  args: Common & {
    readonly rawAmount: bigint;
    readonly fromCollateralRaw: bigint;
    readonly assetIds: readonly string[];
  },
): BuiltBurrowTransaction {
  guard(args, ['repay', 'supply', 'collateral'], 'repay');
  return oracleExecute(
    args.deployment,
    withCollateralRelease(args, args.fromCollateralRaw, 'Repay'),
    args.assetIds,
  );
}

function withCollateralRelease(
  args: Common & { readonly rawAmount: bigint },
  fromCollateralRaw: bigint,
  then: 'Withdraw' | 'Repay',
): Record<string, unknown>[] {
  if (args.rawAmount <= 0n) throw new RangeError('amount must be positive');
  if (fromCollateralRaw < 0n || fromCollateralRaw > args.rawAmount)
    throw new RangeError('the collateral to release must be between zero and the amount');
  const asset = (raw: bigint) => ({
    token_id: args.token.tokenId,
    max_amount: rawToInner(raw, args.token.extraDecimals).toString(),
  });
  return [
    ...(fromCollateralRaw > 0n ? [{ DecreaseCollateral: asset(fromCollateralRaw) }] : []),
    { [then]: asset(args.rawAmount) },
  ];
}

/**
 * NEP-145 registration on the Burrow contract, prepended to a cascade when `storage_balance_of` reports the signer is
 * not registered (the token transfer builders panic otherwise). `deposit` is yoctoNEAR and MUST be the contract's
 * `storage_balance_bounds().min`, resolved on-chain by the caller — never guessed. One yocto is not enough; registration
 * stakes real storage, which is refundable when the account unregisters.
 */
export function buildBurrowStorageDeposit(args: {
  readonly deployment: VerifiedBurrowDeployment;
  readonly accountId: AccountId;
  readonly deposit: bigint;
}): BuiltBurrowTransaction {
  if (args.deposit <= 0n) throw new RangeError('registration deposit must be positive');
  return {
    network: args.deployment.network,
    receiverId: args.deployment.contractId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'storage_deposit',
        args: { account_id: args.accountId, registration_only: true },
        gas: 10_000_000_000_000n,
        deposit: args.deposit,
      },
    ],
  };
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
