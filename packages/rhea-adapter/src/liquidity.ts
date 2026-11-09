import type { AccountId, FunctionCallAction, TokenId } from '@near-autopilot/core';

/**
 * Pure transaction builders for providing liquidity to a Rhea/Ref v1 SIMPLE_POOL. They never sign and never
 * hold keys; each returns the `{ receiverId, actions }` of one step and the caller assembles the cascade.
 *
 * The documented v1 add-liquidity flow (S = ref-exchange contract source, A = ref-ui frontend):
 *   1. The signer must be registered on the EXCHANGE (NEP-145 `storage_deposit`); `ft_on_transfer` with an
 *      empty `msg` panics "E10: account not registered" otherwise (S: account_deposit.rs).
 *   2. Each pool token is moved into the signer's exchange deposit balance with `ft_transfer_call(exchange,
 *      amount, msg="")` (S: `ft_on_transfer`, empty msg = deposit; A: deposit flow).
 *   3. `add_liquidity { pool_id, amounts, min_amounts? }`, `#[payable]`: it mints LP shares proportional to the
 *      pool's current reserve ratio (`fair_shares = min_i(amounts[i] * total / reserve[i])`) and only consumes the
 *      proportional part of each `amounts[i]`; any remainder stays in the exchange deposit balance, never lost
 *      (S: simple_pool.rs `add_liquidity`). The attached deposit is a storage buffer; the contract refunds the
 *      unused part (A: LP_STORAGE_AMOUNT = 0.01 NEAR).
 */

export interface RheaV1BuiltStep {
  readonly receiverId: AccountId;
  readonly actions: readonly FunctionCallAction[];
}

/** Gas constants (A: ref-ui). ft_transfer_call to deposit is light; add_liquidity touches pool + account state. */
export const RHEA_V1_GAS = {
  /** `storage_deposit` on the exchange. */
  storageDeposit: 30_000_000_000_000n,
  /** `ft_transfer_call` with empty msg (credit the exchange deposit balance). */
  deposit: 50_000_000_000_000n,
  /** `add_liquidity`. */
  addLiquidity: 100_000_000_000_000n,
} as const;

/**
 * Default storage buffer attached to `add_liquidity` (A: ref-ui LP_STORAGE_AMOUNT = 0.01 NEAR). It is a buffer,
 * not a fee: the contract refunds whatever it does not spend on the new LP position's storage.
 */
export const RHEA_V1_LP_STORAGE_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR in yocto

/**
 * NEP-145 registration on the EXCHANGE, prepended when `storage_balance_of` reports the signer is not registered.
 * `deposit` is yoctoNEAR and MUST be the exchange's `storage_balance_bounds().min`, read on-chain — never guessed.
 */
export function buildExchangeStorageDeposit(args: {
  readonly contractId: AccountId;
  readonly accountId: AccountId;
  readonly deposit: bigint;
}): RheaV1BuiltStep {
  if (args.deposit <= 0n) throw new RangeError('registration deposit must be positive');
  return {
    receiverId: args.contractId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'storage_deposit',
        args: { account_id: args.accountId, registration_only: true },
        gas: RHEA_V1_GAS.storageDeposit,
        deposit: args.deposit,
      },
    ],
  };
}

/** Move `rawAmount` of `tokenId` into the signer's exchange deposit balance (`ft_transfer_call`, empty msg). */
export function buildExchangeDeposit(args: {
  readonly tokenId: TokenId;
  readonly contractId: AccountId;
  readonly rawAmount: bigint;
}): RheaV1BuiltStep {
  if (args.rawAmount <= 0n) throw new RangeError('deposit amount must be positive');
  return {
    receiverId: args.tokenId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: args.contractId, amount: args.rawAmount.toString(), msg: '' },
        gas: RHEA_V1_GAS.deposit,
        deposit: 1n,
      },
    ],
  };
}

/**
 * `add_liquidity` into a v1 SIMPLE_POOL. `amounts` are the MAX raw amounts to contribute, in the pool's token
 * order; the contract mints shares at the current reserve ratio and leaves any remainder in the deposit balance.
 * `minAmounts` (optional) are a lower bound per token the contract must consume, guarding against a reserve-ratio
 * shift between preview and signing. `storageDeposit` yoctoNEAR is a refundable storage buffer.
 */
export function buildV1AddLiquidity(args: {
  readonly contractId: AccountId;
  readonly poolId: number;
  readonly amounts: readonly [bigint, bigint];
  readonly minAmounts?: readonly [bigint, bigint];
  readonly storageDeposit?: bigint;
}): RheaV1BuiltStep {
  if (!Number.isInteger(args.poolId) || args.poolId < 0) throw new RangeError('invalid pool id');
  if (args.amounts.some((a) => a <= 0n)) throw new RangeError('both amounts must be positive');
  const deposit = args.storageDeposit ?? RHEA_V1_LP_STORAGE_DEPOSIT;
  if (deposit <= 0n) throw new RangeError('storage deposit must be positive');
  const callArgs: Record<string, unknown> = {
    pool_id: args.poolId,
    amounts: args.amounts.map((a) => a.toString()),
  };
  if (args.minAmounts) {
    const [min0, min1] = args.minAmounts;
    const [max0, max1] = args.amounts;
    if (min0 < 0n || min0 > max0 || min1 < 0n || min1 > max1)
      throw new RangeError('min_amounts must be in [0, amounts]');
    callArgs['min_amounts'] = args.minAmounts.map((a) => a.toString());
  }
  return {
    receiverId: args.contractId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'add_liquidity',
        args: callArgs,
        gas: RHEA_V1_GAS.addLiquidity,
        deposit,
      },
    ],
  };
}
