import type { AccountId, FunctionCallAction } from '@near-autopilot/core';
import { DCL_DEPOSITS, DCL_GAS, ONE_YOCTO, POINT_MAX, POINT_MIN } from './constants';
import { canonicalPoolId, normalisePoolId, parsePoolId } from './client';
import { assertValidRange } from './math';

/**
 * Pure builders for DCL state-changing calls. They only describe transactions; signing, policy
 * approval and broadcast stay with the existing TransactionSigner / policy engine / Broadcaster.
 * Method names and argument names were read in ref-finance/ref-sdk and ref-finance/ref-ui (tier A);
 * the file that proves each one is named on the builder.
 *
 * Amounts are raw bigint token units and are serialised as decimal strings, as the contract expects.
 */

/** One NEAR transaction draft: receiver plus ordered actions. The planner adds intent id and signer. */
export interface DclTransactionDraft {
  readonly receiverId: AccountId;
  readonly actions: readonly FunctionCallAction[];
}

function positive(name: string, value: bigint): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}
function nonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new RangeError(`${name} must be non-negative`);
}

function call(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: bigint,
): FunctionCallAction {
  return { type: 'FunctionCall', methodName, args, gas, deposit };
}

function transferCall(
  token: AccountId,
  dcl: AccountId,
  amount: bigint,
  msg: string,
  gas: bigint,
): DclTransactionDraft {
  positive('amount', amount);
  return {
    receiverId: token,
    actions: [
      call(
        'ft_transfer_call',
        { receiver_id: dcl, amount: amount.toString(), msg },
        gas,
        ONE_YOCTO,
      ),
    ],
  };
}

function assertPoolHasToken(poolId: string, token: string, label: string): void {
  const { tokenX, tokenY } = parsePoolId(poolId);
  if (token !== tokenX && token !== tokenY)
    throw new RangeError(`${label} ${token} is not a token of pool ${poolId}`);
}

export interface RoutingTags {
  readonly referralId?: string;
  readonly clientId?: string;
}

/** `Swap` message (ref-sdk dcl-swap/swap.ts). Exact-input swap routed through `poolIds`. */
export function buildSwapExactIn(
  args: {
    readonly dcl: AccountId;
    readonly tokenIn: AccountId;
    readonly tokenOut: AccountId;
    readonly amountIn: bigint;
    readonly minAmountOut: bigint;
    readonly poolIds: readonly string[];
  } & RoutingTags,
): DclTransactionDraft {
  if (args.poolIds.length === 0) throw new RangeError('poolIds must not be empty');
  nonNegative('minAmountOut', args.minAmountOut);
  const msg = JSON.stringify({
    Swap: {
      pool_ids: args.poolIds.map(normalisePoolId),
      output_token: args.tokenOut,
      min_output_amount: args.minAmountOut.toString(),
      referral_id: args.referralId ?? '',
      client_id: args.clientId ?? '',
    },
  });
  return transferCall(args.tokenIn, args.dcl, args.amountIn, msg, DCL_GAS.swapTransferCall);
}

/**
 * `SwapByOutput` message (ref-sdk). `amountInMax` is what is transferred; unspent input is refunded by
 * the contract's ft_resolve flow (refund behaviour is NOT verified in source here).
 */
export function buildSwapExactOut(
  args: {
    readonly dcl: AccountId;
    readonly tokenIn: AccountId;
    readonly tokenOut: AccountId;
    readonly amountInMax: bigint;
    readonly amountOut: bigint;
    readonly poolIds: readonly string[];
  } & RoutingTags,
): DclTransactionDraft {
  if (args.poolIds.length === 0) throw new RangeError('poolIds must not be empty');
  positive('amountOut', args.amountOut);
  const msg = JSON.stringify({
    SwapByOutput: {
      pool_ids: args.poolIds.map(normalisePoolId),
      output_token: args.tokenOut,
      output_amount: args.amountOut.toString(),
      referral_id: args.referralId ?? '',
      client_id: args.clientId ?? '',
    },
  });
  return transferCall(args.tokenIn, args.dcl, args.amountInMax, msg, DCL_GAS.swapTransferCall);
}

/**
 * ref-sdk orients the limit-order point by the sold token: if the sold token is the pool's token X the point
 * is used as-is, otherwise it is negated (swap.ts `new_point`). Pass the point computed from the SOLD token's
 * perspective (price of sold token in bought token) and get the pool-oriented point back.
 */
export function orientLimitOrderPoint(
  poolId: string,
  sellToken: string,
  pointFromSellerPerspective: number,
): number {
  const { tokenX, tokenY } = parsePoolId(poolId);
  if (sellToken !== tokenX && sellToken !== tokenY)
    throw new RangeError(`${sellToken} is not in pool ${poolId}`);
  return sellToken === tokenX ? pointFromSellerPerspective : -pointFromSellerPerspective;
}

/** `LimitOrderWithSwap` message (ref-sdk). `point` is already pool-oriented (see orientLimitOrderPoint). */
export function buildLimitOrder(
  args: {
    readonly dcl: AccountId;
    readonly sellToken: AccountId;
    readonly buyToken: AccountId;
    readonly amount: bigint;
    readonly poolId: string;
    readonly point: number;
  } & RoutingTags,
): DclTransactionDraft {
  const poolId = normalisePoolId(args.poolId);
  assertPoolHasToken(poolId, args.sellToken, 'sellToken');
  assertPoolHasToken(poolId, args.buyToken, 'buyToken');
  if (args.sellToken === args.buyToken) throw new RangeError('sellToken and buyToken must differ');
  if (!Number.isInteger(args.point) || args.point < POINT_MIN || args.point > POINT_MAX) {
    throw new RangeError(`point ${args.point} out of range`);
  }
  const msg = JSON.stringify({
    LimitOrderWithSwap: {
      pool_id: poolId,
      buy_token: args.buyToken,
      point: args.point,
      client_id: args.clientId ?? '',
      referral_id: args.referralId ?? '',
    },
  });
  return transferCall(args.sellToken, args.dcl, args.amount, msg, DCL_GAS.swapTransferCall);
}

/** `SwapByStopPoint` message (ref-sdk). Swaps until the pool reaches `stopPoint`. */
export function buildSwapToStopPoint(
  args: {
    readonly dcl: AccountId;
    readonly tokenIn: AccountId;
    readonly amountIn: bigint;
    readonly poolId: string;
    readonly stopPoint: number;
    readonly skipUnwrapNear?: boolean;
  } & Pick<RoutingTags, 'referralId'>,
): DclTransactionDraft {
  const poolId = normalisePoolId(args.poolId);
  assertPoolHasToken(poolId, args.tokenIn, 'tokenIn');
  if (
    !Number.isInteger(args.stopPoint) ||
    args.stopPoint < POINT_MIN ||
    args.stopPoint > POINT_MAX
  ) {
    throw new RangeError(`stopPoint ${args.stopPoint} out of range`);
  }
  const body: Record<string, unknown> = {
    pool_id: poolId,
    stop_point: args.stopPoint,
    referral_id: args.referralId ?? '',
  };
  if (args.skipUnwrapNear !== undefined) body['skip_unwrap_near'] = args.skipUnwrapNear;
  return transferCall(
    args.tokenIn,
    args.dcl,
    args.amountIn,
    JSON.stringify({ SwapByStopPoint: body }),
    DCL_GAS.swapTransferCall,
  );
}

/**
 * Deposit tokens into the user's internal balance on the DCL contract: `ft_transfer_call` with the
 * message `"Deposit"` (a JSON string literal), as in ref-ui swapV3.ts add_liquidity.
 */
export function buildDeposit(args: {
  readonly dcl: AccountId;
  readonly token: AccountId;
  readonly amount: bigint;
}): DclTransactionDraft {
  return transferCall(
    args.token,
    args.dcl,
    args.amount,
    JSON.stringify('Deposit'),
    DCL_GAS.depositTransferCall,
  );
}

/** `add_liquidity` (ref-ui swapV3.ts). Spends the caller's INTERNAL balances; deposit first. */
export function buildAddLiquidity(args: {
  readonly dcl: AccountId;
  readonly poolId: string;
  readonly leftPoint: number;
  readonly rightPoint: number;
  readonly pointDelta: number;
  readonly amountX: bigint;
  readonly amountY: bigint;
  readonly minAmountX?: bigint;
  readonly minAmountY?: bigint;
}): DclTransactionDraft {
  nonNegative('amountX', args.amountX);
  nonNegative('amountY', args.amountY);
  if (args.amountX === 0n && args.amountY === 0n)
    throw new RangeError('at least one amount must be positive');
  assertValidRange(args.leftPoint, args.rightPoint, args.pointDelta);
  return {
    receiverId: args.dcl,
    actions: [
      call(
        'add_liquidity',
        {
          pool_id: normalisePoolId(args.poolId),
          left_point: args.leftPoint,
          right_point: args.rightPoint,
          amount_x: args.amountX.toString(),
          amount_y: args.amountY.toString(),
          min_amount_x: (args.minAmountX ?? 0n).toString(),
          min_amount_y: (args.minAmountY ?? 0n).toString(),
        },
        DCL_GAS.addLiquidity,
        0n,
      ),
    ],
  };
}

/** `append_liquidity` - add to an existing position (ref-ui). */
export function buildAppendLiquidity(args: {
  readonly dcl: AccountId;
  readonly lptId: string;
  readonly amountX: bigint;
  readonly amountY: bigint;
  readonly minAmountX?: bigint;
  readonly minAmountY?: bigint;
}): DclTransactionDraft {
  nonNegative('amountX', args.amountX);
  nonNegative('amountY', args.amountY);
  if (args.amountX === 0n && args.amountY === 0n)
    throw new RangeError('at least one amount must be positive');
  return {
    receiverId: args.dcl,
    actions: [
      call(
        'append_liquidity',
        {
          lpt_id: args.lptId,
          amount_x: args.amountX.toString(),
          amount_y: args.amountY.toString(),
          min_amount_x: (args.minAmountX ?? 0n).toString(),
          min_amount_y: (args.minAmountY ?? 0n).toString(),
        },
        DCL_GAS.appendLiquidity,
        0n,
      ),
    ],
  };
}

/**
 * `remove_liquidity { lpt_id, amount, min_amount_x, min_amount_y }` (ref-ui). `amount` is LIQUIDITY units
 * (the position's `amount` field), not token units. Proceeds land in the internal balance; follow with
 * `buildWithdrawAssets` to move them to the wallet.
 */
export function buildRemoveLiquidity(args: {
  readonly dcl: AccountId;
  readonly lptId: string;
  readonly liquidity: bigint;
  readonly minAmountX: bigint;
  readonly minAmountY: bigint;
}): DclTransactionDraft {
  positive('liquidity', args.liquidity);
  nonNegative('minAmountX', args.minAmountX);
  nonNegative('minAmountY', args.minAmountY);
  return {
    receiverId: args.dcl,
    actions: [
      call(
        'remove_liquidity',
        {
          lpt_id: args.lptId,
          amount: args.liquidity.toString(),
          min_amount_x: args.minAmountX.toString(),
          min_amount_y: args.minAmountY.toString(),
        },
        DCL_GAS.removeLiquidity,
        0n,
      ),
    ],
  };
}

/** `burn_v_liquidity { lpt_id }` - required before modifying a position that is staked as a virtual LP (ref-ui). */
export function buildBurnVirtualLiquidity(args: {
  readonly dcl: AccountId;
  readonly lptId: string;
}): DclTransactionDraft {
  return {
    receiverId: args.dcl,
    actions: [call('burn_v_liquidity', { lpt_id: args.lptId }, 100_000_000_000_000n, 0n)],
  };
}

/** `withdraw_asset { token_id }` for each token, in one transaction (ref-ui swapV3.ts). */
export function buildWithdrawAssets(args: {
  readonly dcl: AccountId;
  readonly tokenIds: readonly AccountId[];
}): DclTransactionDraft {
  if (args.tokenIds.length === 0) throw new RangeError('tokenIds must not be empty');
  return {
    receiverId: args.dcl,
    actions: args.tokenIds.map((tokenId) =>
      call('withdraw_asset', { token_id: tokenId }, DCL_GAS.withdrawAsset, 0n),
    ),
  };
}

/** `cancel_order { order_id, amount }` - cancel `amount` of the remaining order; `0` only claims proceeds. */
export function buildCancelOrder(args: {
  readonly dcl: AccountId;
  readonly orderId: string;
  readonly amount: bigint;
}): DclTransactionDraft {
  nonNegative('amount', args.amount);
  return {
    receiverId: args.dcl,
    actions: [
      call(
        'cancel_order',
        { order_id: args.orderId, amount: args.amount.toString() },
        DCL_GAS.cancelOrder,
        0n,
      ),
    ],
  };
}

export function buildClaimOrder(args: {
  readonly dcl: AccountId;
  readonly orderId: string;
}): DclTransactionDraft {
  return buildCancelOrder({ ...args, amount: 0n });
}

/** `create_pool { token_a, token_b, fee, init_point }` with 0.1 NEAR attached (ref-ui swapV3.ts). */
export function buildCreatePool(args: {
  readonly dcl: AccountId;
  readonly tokenA: AccountId;
  readonly tokenB: AccountId;
  readonly fee: number;
  readonly initPoint: number;
}): DclTransactionDraft {
  canonicalPoolId(args.tokenA, args.tokenB, args.fee);
  if (
    !Number.isInteger(args.initPoint) ||
    args.initPoint < POINT_MIN ||
    args.initPoint > POINT_MAX
  ) {
    throw new RangeError(`initPoint ${args.initPoint} out of range`);
  }
  return {
    receiverId: args.dcl,
    actions: [
      call(
        'create_pool',
        { token_a: args.tokenA, token_b: args.tokenB, fee: args.fee, init_point: args.initPoint },
        DCL_GAS.createPool,
        DCL_DEPOSITS.createPool,
      ),
    ],
  };
}

/** `storage_deposit { registration_only: true, account_id }` on the DCL contract (ref-sdk limit-order flow). */
export function buildDclStorageDeposit(args: {
  readonly dcl: AccountId;
  readonly accountId: AccountId;
  readonly deposit?: bigint;
}): DclTransactionDraft {
  return {
    receiverId: args.dcl,
    actions: [
      call(
        'storage_deposit',
        { registration_only: true, account_id: args.accountId },
        DCL_GAS.storageDeposit,
        args.deposit ?? DCL_DEPOSITS.firstRegistration,
      ),
    ],
  };
}
