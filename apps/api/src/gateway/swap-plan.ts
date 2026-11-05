import { accountIdSchema, type PlannedTransaction, type TokenId } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * The swap inside an approved Rhea plan, read back from the plan itself (the bytes that were hashed and approved),
 * never from the intent: what is compared across venues is exactly what would have been signed. Anything but a single
 * `ft_transfer_call` to the exchange carrying a single swap action is not a swap here (null).
 */
export interface PlannedSwap {
  readonly tokenIn: TokenId;
  readonly tokenOut: TokenId;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly poolId: number;
  readonly attachedGas: bigint;
}

const u128 = z.string().regex(/^\d{1,40}$/);
const message = z.object({
  actions: z
    .array(
      z.object({
        pool_id: z.number().int().nonnegative(),
        token_in: z.string(),
        token_out: z.string(),
        amount_in: u128,
        min_amount_out: u128,
      }),
    )
    .length(1),
});
const args = z.object({ receiver_id: z.string(), amount: u128, msg: z.string() });

export function plannedSwap(plan: PlannedTransaction, exchange: string): PlannedSwap | null {
  const [action, ...rest] = plan.actions;
  if (!action || rest.length > 0 || action.methodName !== 'ft_transfer_call') return null;
  const a = args.safeParse(action.args);
  if (!a.success || a.data.receiver_id !== exchange) return null;
  let body: unknown;
  try {
    body = JSON.parse(a.data.msg);
  } catch {
    return null;
  }
  const m = message.safeParse(body);
  const swap = m.success ? m.data.actions[0] : undefined;
  if (!swap || swap.token_in !== plan.receiverId || swap.amount_in !== a.data.amount) return null;
  const tokenOut = accountIdSchema.safeParse(swap.token_out);
  if (!tokenOut.success) return null;
  return {
    tokenIn: plan.receiverId,
    tokenOut: tokenOut.data,
    amountIn: BigInt(swap.amount_in),
    minAmountOut: BigInt(swap.min_amount_out),
    poolId: swap.pool_id,
    attachedGas: action.gas,
  };
}
