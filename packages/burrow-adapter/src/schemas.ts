import { accountIdSchema, u128StringSchema } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * Response schemas. Field names come from the contract source (S): `AssetDetailedView`, `AssetConfig`,
 * `Pool`, `AccountDetailedView`, `Config` in burrowland, and `PriceData`/`Price` in price-oracle.
 * Everything fails closed: a response that does not parse raises, it is never coerced. Unknown fields are
 * kept (`passthrough`) so newer contract versions that add fields do not break reads.
 */

const int = z.number().int();
/** BigDecimal APR fields: serialised as strings by the contract; kept as strings (display only). */
const decimalText = z.union([z.string(), z.number()]).transform((v) => String(v));

export const poolSchema = z
  .object({ shares: u128StringSchema, balance: u128StringSchema })
  .passthrough();

/** S: asset_config.rs `AssetConfig`. `net_tvl_multiplier` is absent in older versions, hence optional. */
export const assetConfigSchema = z
  .object({
    reserve_ratio: int.min(0).max(10_000),
    target_utilization: int.min(0).max(10_000),
    /** Basis points. Collateral is weighted by it; debt is divided by it (S: actions.rs compute_max_discount). */
    volatility_ratio: int.min(0).max(10_000),
    /** Inner balance = raw units * 10^extra_decimals. */
    extra_decimals: int.min(0).max(38),
    can_deposit: z.boolean(),
    can_withdraw: z.boolean(),
    can_use_as_collateral: z.boolean(),
    can_borrow: z.boolean(),
    net_tvl_multiplier: int.optional(),
  })
  .passthrough();

/** `get_asset` / `get_assets_paged_detailed` entries. `null` from `get_asset` means the token is not listed. */
export const assetDetailedObjectSchema = z
  .object({
    token_id: accountIdSchema,
    supplied: poolSchema,
    borrowed: poolSchema,
    reserved: u128StringSchema,
    config: assetConfigSchema,
    supply_apr: decimalText.optional(),
    borrow_apr: decimalText.optional(),
    /** Nanoseconds; when the asset's interest was last accrued (S: asset.rs `last_update_timestamp`). */
    last_update_timestamp: z.union([z.string().regex(/^\d+$/), int.nonnegative()]).optional(),
    /**
     * S: asset_view.rs `AssetFarmView`: `farm_id` is {"Supplied": token} | {"Borrowed": token} | "NetTvl"; `rewards`
     * maps a reward token to `AssetFarmReward` (reward_per_day, remaining_rewards, boosted_shares: u128 strings).
     */
    farms: z
      .array(
        z
          .object({
            farm_id: z.union([z.string(), z.record(z.string())]),
            rewards: z.record(
              z
                .object({
                  reward_per_day: u128StringSchema,
                  remaining_rewards: u128StringSchema,
                  boosted_shares: u128StringSchema,
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export const assetDetailedSchema = assetDetailedObjectSchema.nullable();
export const assetListSchema = z.array(assetDetailedObjectSchema);

const accountBalanceSchema = z
  .object({
    token_id: accountIdSchema,
    /** Inner units (see `config.extra_decimals`). */
    balance: u128StringSchema,
    shares: u128StringSchema.optional(),
    apr: decimalText.optional(),
  })
  .passthrough();

/** S: account_view.rs `AccountDetailedView`. `null` means the account is not registered. */
export const accountDetailedSchema = z
  .object({
    account_id: accountIdSchema,
    supplied: z.array(accountBalanceSchema),
    collateral: z.array(accountBalanceSchema),
    borrowed: z.array(accountBalanceSchema),
  })
  .passthrough()
  .nullable();

/** S: config.rs `Config` (only the fields this adapter needs are required). */
export const burrowConfigSchema = z
  .object({
    oracle_account_id: accountIdSchema,
    owner_id: accountIdSchema.optional(),
    max_num_assets: int.optional(),
    maximum_recency_duration_sec: int.optional(),
    maximum_staleness_duration_sec: int.optional(),
    force_closing_enabled: z.boolean().optional(),
  })
  .passthrough();

/** S: price-oracle `PriceData`. `timestamp` is the BLOCK time of the view, not of the last report. */
export const priceDataSchema = z
  .object({
    timestamp: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]),
    recency_duration_sec: int.optional(),
    prices: z.array(
      z.object({
        /** May carry an EMA suffix such as `wrap.near#3600`, so it is not an account id. */
        asset_id: z.string().min(1),
        price: z.object({ multiplier: u128StringSchema, decimals: int.min(0).max(64) }).nullable(),
      }),
    ),
  })
  .passthrough();

/** NEP-145 `storage_balance_of`; `null` = not registered. */
export const storageBalanceSchema = z
  .object({ total: u128StringSchema, available: u128StringSchema })
  .passthrough()
  .nullable();
