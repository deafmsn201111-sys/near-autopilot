import type { AccountId, ContractViewer, TokenId, UnitPrice } from '@near-autopilot/core';
import { accountIdSchema, UnexpectedResponseError } from '@near-autopilot/core';
import type { z } from 'zod';
import {
  accountDetailedSchema,
  assetDetailedSchema,
  assetListSchema,
  burrowConfigSchema,
  priceDataSchema,
  storageBalanceSchema,
} from './schemas';

/** One asset as Burrow lists it. Amounts are inner units (raw * 10^extraDecimals). */
export interface BurrowAsset {
  readonly tokenId: TokenId;
  readonly extraDecimals: number;
  /** Basis points; collateral weight AND the divisor applied to debt. */
  readonly volatilityRatioBps: number;
  readonly canDeposit: boolean;
  readonly canWithdraw: boolean;
  readonly canUseAsCollateral: boolean;
  readonly canBorrow: boolean;
  readonly suppliedInner: bigint;
  readonly borrowedInner: bigint;
  readonly reservedInner: bigint;
  readonly supplyApr: string | null;
  readonly borrowApr: string | null;
  /** Nanoseconds since epoch, when the contract last accrued this asset; null if not reported. */
  readonly lastUpdateTimestampNs: bigint | null;
  /** Supply shares (pool `supplied.shares`); rewards are paid per boosted share. */
  readonly suppliedShares: bigint;
  /** Reward programmes on SUPPLYING this asset (`farm_id: {"Supplied": token}`); empty if none. */
  readonly supplyFarms: readonly BurrowFarmReward[];
}

export interface BurrowFarmReward {
  readonly rewardToken: TokenId;
  /** Reward token raw units per day, shared across all boosted shares. */
  readonly rewardPerDay: bigint;
  readonly remainingRewards: bigint;
  readonly boostedShares: bigint;
}

export interface BurrowAccountBalance {
  readonly tokenId: TokenId;
  /** Inner units. */
  readonly inner: bigint;
}

export interface BurrowAccount {
  readonly accountId: AccountId;
  /** Deposited but not collateral. */
  readonly supplied: readonly BurrowAccountBalance[];
  readonly collateral: readonly BurrowAccountBalance[];
  readonly borrowed: readonly BurrowAccountBalance[];
}

export interface BurrowConfig {
  readonly oracleAccountId: AccountId;
  readonly ownerId: AccountId | null;
  readonly maximumRecencyDurationSec: number | null;
  readonly maximumStalenessDurationSec: number | null;
}

export interface BurrowPriceData {
  /** Block time (ns) of the view call. The oracle already nulls out prices older than `recencyDurationSec`. */
  readonly blockTimestampNs: bigint;
  readonly recencyDurationSec: number | null;
  readonly prices: ReadonlyMap<string, UnitPrice>;
  /** Requested assets for which the oracle has no recent price. They must never be valued. */
  readonly unpriced: readonly string[];
}

type AssetView = NonNullable<z.infer<typeof assetDetailedSchema>>;

function toAsset(view: AssetView): BurrowAsset {
  const c = view.config;
  return {
    tokenId: view.token_id,
    extraDecimals: c.extra_decimals,
    volatilityRatioBps: c.volatility_ratio,
    canDeposit: c.can_deposit,
    canWithdraw: c.can_withdraw,
    canUseAsCollateral: c.can_use_as_collateral,
    canBorrow: c.can_borrow,
    suppliedInner: view.supplied.balance,
    borrowedInner: view.borrowed.balance,
    reservedInner: view.reserved,
    supplyApr: view.supply_apr ?? null,
    borrowApr: view.borrow_apr ?? null,
    lastUpdateTimestampNs:
      view.last_update_timestamp === undefined ? null : BigInt(view.last_update_timestamp),
    suppliedShares: view.supplied.shares,
    supplyFarms: (view.farms ?? []).flatMap((f) =>
      typeof f.farm_id === 'object' && f.farm_id.Supplied === view.token_id
        ? Object.entries(f.rewards).flatMap(([token, r]) => {
            const parsed = accountIdSchema.safeParse(token);
            return parsed.success
              ? [
                  {
                    rewardToken: parsed.data,
                    rewardPerDay: r.reward_per_day,
                    remainingRewards: r.remaining_rewards,
                    boostedShares: r.boosted_shares,
                  },
                ]
              : [];
          })
        : [],
    ),
  };
}

const ASSET_PAGE = 50;
const MAX_ASSET_PAGES = 20;

/** Read-only, schema-validated client for the Burrow contract. Holds no state and never signs. */
export class BurrowClient {
  constructor(
    private readonly viewer: ContractViewer,
    readonly contractId: AccountId,
  ) {}

  private async read<T>(
    contract: AccountId,
    method: string,
    args: Record<string, unknown> | undefined,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const raw = await this.viewer.view(contract, method, args);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new UnexpectedResponseError(`${contract}#${method}`, detail, { cause: parsed.error });
    }
    return parsed.data;
  }

  /** `get_config`. Gives the oracle account Burrow actually trusts. */
  async getConfig(): Promise<BurrowConfig> {
    const c = await this.read(this.contractId, 'get_config', undefined, burrowConfigSchema);
    return {
      oracleAccountId: c.oracle_account_id,
      ownerId: c.owner_id ?? null,
      maximumRecencyDurationSec: c.maximum_recency_duration_sec ?? null,
      maximumStalenessDurationSec: c.maximum_staleness_duration_sec ?? null,
    };
  }

  /** `get_asset { token_id }`; null when Burrow does not list the token. */
  async getAsset(tokenId: TokenId): Promise<BurrowAsset | null> {
    const view = await this.read(
      this.contractId,
      'get_asset',
      { token_id: tokenId },
      assetDetailedSchema,
    );
    return view ? toAsset(view) : null;
  }

  /**
   * `get_assets_paged_detailed { from_index, limit }`. The contract's own paging has varied between versions
   * (`limit` as page size vs as end index), so pages are requested with `limit = from + pageSize`, de-duplicated
   * by token id, and the loop ends on the first page that adds nothing new.
   */
  async listAssets(): Promise<BurrowAsset[]> {
    const seen = new Map<string, BurrowAsset>();
    for (let page = 0; page < MAX_ASSET_PAGES; page += 1) {
      const from = seen.size;
      const views = await this.read(
        this.contractId,
        'get_assets_paged_detailed',
        { from_index: from, limit: from + ASSET_PAGE },
        assetListSchema,
      );
      const before = seen.size;
      for (const v of views) if (!seen.has(v.token_id)) seen.set(v.token_id, toAsset(v));
      if (seen.size === before || views.length === 0) return [...seen.values()];
    }
    throw new UnexpectedResponseError(
      `${this.contractId}#get_assets_paged_detailed`,
      'asset listing did not terminate',
    );
  }

  /** `get_account { account_id }`; null when the account is not registered with Burrow. */
  async getAccount(accountId: AccountId): Promise<BurrowAccount | null> {
    const view = await this.read(
      this.contractId,
      'get_account',
      { account_id: accountId },
      accountDetailedSchema,
    );
    if (!view) return null;
    const toBalances = (
      entries: ReadonlyArray<{ token_id: TokenId; balance: bigint }>,
    ): BurrowAccountBalance[] =>
      entries.filter((e) => e.balance > 0n).map((e) => ({ tokenId: e.token_id, inner: e.balance }));
    return {
      accountId: view.account_id,
      supplied: toBalances(view.supplied),
      collateral: toBalances(view.collateral),
      borrowed: toBalances(view.borrowed),
    };
  }

  /** NEP-145 `storage_balance_of { account_id }` on the Burrow contract; null = not registered. */
  async getStorageBalance(
    accountId: AccountId,
  ): Promise<{ total: bigint; available: bigint } | null> {
    const result = await this.read(
      this.contractId,
      'storage_balance_of',
      { account_id: accountId },
      storageBalanceSchema,
    );
    return result ? { total: result.total, available: result.available } : null;
  }
}

/** Read-only client for the price oracle Burrow is configured with. */
export class BurrowOracleClient {
  constructor(
    private readonly viewer: ContractViewer,
    readonly oracleId: AccountId,
  ) {}

  /** `get_price_data { asset_ids }` (S: price-oracle lib.rs). Prices are USD per RAW unit: multiplier / 10^decimals. */
  async getPriceData(assetIds: readonly string[]): Promise<BurrowPriceData> {
    const unique = [...new Set(assetIds)];
    const raw = await this.viewer.view(this.oracleId, 'get_price_data', { asset_ids: unique });
    const parsed = priceDataSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new UnexpectedResponseError(`${this.oracleId}#get_price_data`, detail, {
        cause: parsed.error,
      });
    }
    const prices = new Map<string, UnitPrice>();
    const answered = new Set<string>();
    for (const entry of parsed.data.prices) {
      answered.add(entry.asset_id);
      if (entry.price && entry.price.multiplier > 0n) {
        prices.set(entry.asset_id, {
          multiplier: entry.price.multiplier,
          decimals: entry.price.decimals,
        });
      }
    }
    const blockTimestampNs = BigInt(parsed.data.timestamp);
    if (blockTimestampNs <= 0n)
      throw new UnexpectedResponseError(`${this.oracleId}#get_price_data`, 'invalid timestamp');
    const unpriced = unique.filter((id) => !prices.has(id) || !answered.has(id));
    return {
      blockTimestampNs,
      recencyDurationSec: parsed.data.recency_duration_sec ?? null,
      prices,
      unpriced,
    };
  }
}
