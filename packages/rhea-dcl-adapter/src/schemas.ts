import { accountIdSchema, u128StringSchema } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * Response schemas. Field names come from the TypeScript interfaces in ref-finance/ref-ui
 * (`PoolInfo`, `UserLiquidityInfo`, `UserStorageDetail`, `ILiquidityInfoPool`, `IOrderInfoPool`) and
 * ref-finance/ref-sdk (`UserOrderInfo`). Those interfaces are tier A for field NAMES; they are not a
 * contract ABI, so numeric-vs-string encodings are enforced strictly here and checked against a live
 * node by test/live.integration.test.ts. Unknown extra fields are preserved, not rejected.
 *
 * Every schema fails closed: a response that does not parse raises, it is never coerced.
 */

const int = z.number().int();

export const poolInfoSchema = z
  .object({
    pool_id: z.string().min(1),
    token_x: accountIdSchema,
    token_y: accountIdSchema,
    fee: int,
    point_delta: int.positive(),
    current_point: int,
    /** "Running" | "Paused" per ref-ui comment (`// running or paused`); kept as an open string. */
    state: z.string(),
    liquidity: u128StringSchema.optional(),
    liquidity_x: u128StringSchema.optional(),
    max_liquidity_per_point: u128StringSchema.optional(),
    total_liquidity: u128StringSchema.optional(),
    total_x: u128StringSchema.optional(),
    total_y: u128StringSchema.optional(),
    total_fee_x_charged: u128StringSchema.optional(),
    total_fee_y_charged: u128StringSchema.optional(),
  })
  .passthrough();
export type DclPool = z.infer<typeof poolInfoSchema>;

/** NFT-like LP position (`lpt_id`), a liquidity range [left_point, right_point) with `amount` of liquidity. */
export const liquidityInfoSchema = z
  .object({
    lpt_id: z.string().min(1),
    owner_id: accountIdSchema.optional(),
    pool_id: z.string().min(1),
    left_point: int,
    right_point: int,
    amount: u128StringSchema,
    unclaimed_fee_x: u128StringSchema.optional(),
    unclaimed_fee_y: u128StringSchema.optional(),
    mft_id: z.string().optional(),
    v_liquidity: u128StringSchema.optional(),
  })
  .passthrough();
export type DclPosition = z.infer<typeof liquidityInfoSchema>;

export const marketDepthSchema = z.object({
  liquidities: z.record(
    z.object({ left_point: int, right_point: int, amount_l: u128StringSchema }).passthrough(),
  ),
  orders: z.record(
    z.object({ point: int, amount_x: u128StringSchema, amount_y: u128StringSchema }).passthrough(),
  ),
});
export type DclMarketDepth = z.infer<typeof marketDepthSchema>;

/** ref-sdk `quote` consumers read `.amount` and `.tag`. */
export const quoteSchema = z
  .object({ amount: u128StringSchema, tag: z.string().nullable().optional() })
  .passthrough();
export type DclQuote = z.infer<typeof quoteSchema>;

/** ref-sdk `UserOrderInfo`. Amount fields the SDK comments mark as always present are required. */
export const orderInfoSchema = z
  .object({
    order_id: z.string().min(1),
    owner_id: accountIdSchema,
    pool_id: z.string().min(1),
    point: int,
    sell_token: accountIdSchema,
    buy_token: accountIdSchema,
    created_at: z.union([z.string(), z.number()]),
    original_amount: u128StringSchema,
    original_deposit_amount: u128StringSchema.optional(),
    swap_earn_amount: u128StringSchema.optional(),
    remain_amount: u128StringSchema,
    cancel_amount: u128StringSchema,
    bought_amount: u128StringSchema,
    unclaimed_amount: u128StringSchema.nullable().optional(),
  })
  .passthrough();
export type DclOrder = z.infer<typeof orderInfoSchema>;

/** ref-ui `UserStorageDetail`; `null` from the contract means the account is not registered. */
export const userStorageDetailSchema = z
  .object({
    max_slots: int,
    cur_order_slots: int,
    cur_liquidity_slots: int,
    locked_near: u128StringSchema,
    storage_for_asset: u128StringSchema,
    slot_price: u128StringSchema,
    sponsor_id: accountIdSchema,
  })
  .passthrough()
  .nullable();
export type DclUserStorageDetail = z.infer<typeof userStorageDetailSchema>;

/** `list_user_assets` -> internal (non-withdrawn) balances keyed by token id. Shape read in ref-ui as a plain object. */
export const userAssetsSchema = z.record(u128StringSchema).nullable();

/** NEP-145 storage balance, `null` when unregistered. */
export const storageBalanceSchema = z
  .object({ total: u128StringSchema, available: u128StringSchema })
  .passthrough()
  .nullable();

export const poolListSchema = z.array(poolInfoSchema);
export const positionListSchema = z.array(liquidityInfoSchema);
export const orderListSchema = z.array(orderInfoSchema);
