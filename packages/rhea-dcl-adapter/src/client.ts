import type { AccountId, ContractViewer } from '@near-autopilot/core';
import { UnexpectedResponseError } from '@near-autopilot/core';
import type { z } from 'zod';
import { isDclFee } from './constants';
import {
  liquidityInfoSchema,
  marketDepthSchema,
  orderInfoSchema,
  orderListSchema,
  poolInfoSchema,
  poolListSchema,
  positionListSchema,
  quoteSchema,
  storageBalanceSchema,
  userAssetsSchema,
  userStorageDetailSchema,
  type DclMarketDepth,
  type DclOrder,
  type DclPool,
  type DclPosition,
  type DclQuote,
  type DclUserStorageDetail,
} from './schemas';

export interface RheaDclClientOptions {
  /** The DCL contract account (see DCL_CONTRACT_IDS). */
  readonly contractId: AccountId;
}

/** `tokenA|tokenB|fee` with the two tokens sorted lexicographically (ref-sdk getDCLPoolId). */
export function canonicalPoolId(tokenA: string, tokenB: string, fee: number): string {
  if (!isDclFee(fee)) throw new RangeError(`Unsupported DCL fee ${fee}`);
  if (tokenA === tokenB) throw new RangeError('A pool needs two distinct tokens');
  return `${[tokenA, tokenB].sort().join('|')}|${fee}`;
}

export function parsePoolId(poolId: string): {
  readonly tokenX: string;
  readonly tokenY: string;
  readonly fee: number;
} {
  const parts = poolId.split('|');
  const [tokenX, tokenY, feeText] = parts;
  const fee = Number(feeText);
  if (parts.length !== 3 || !tokenX || !tokenY || !isDclFee(fee)) {
    throw new RangeError(`Malformed DCL pool id: ${JSON.stringify(poolId)}`);
  }
  return { tokenX, tokenY, fee };
}

/** Normalises a user-supplied pool id the way ref-ui `get_pool` does before querying. */
export function normalisePoolId(poolId: string): string {
  const { tokenX, tokenY, fee } = parsePoolId(poolId);
  return canonicalPoolId(tokenX, tokenY, fee);
}

/**
 * Read-only typed client for the Rhea/Ref v2 DCL contract. Every method is a thin, validated wrapper
 * around exactly one view method whose name and argument names were read in source (see
 * docs/rhea-dcl-capability-matrix.md). It holds no state and never signs.
 */
export class RheaDclClient {
  private readonly contractId: AccountId;

  constructor(
    private readonly viewer: ContractViewer,
    options: RheaDclClientOptions,
  ) {
    this.contractId = options.contractId;
  }

  private async read<T>(
    method: string,
    args: Record<string, unknown> | undefined,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const raw = await this.viewer.view(this.contractId, method, args);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new UnexpectedResponseError(
        `${this.contractId}#${method}`,
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        {
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }

  /** `get_pool { pool_id }`. Returns null if the contract answers null (unknown pool). */
  async getPool(poolId: string): Promise<DclPool | null> {
    return this.read('get_pool', { pool_id: normalisePoolId(poolId) }, poolInfoSchema.nullable());
  }

  /**
   * `list_pools` (no arguments in ref-ui/ref-sdk). On a deployment with many pools this single call can
   * exceed the view gas limit; that surfaces as an UnexpectedResponseError from the RPC layer, never as
   * a silently truncated list.
   */
  /**
   * `list_pools { from_index?, limit? }`. Pass a page on large deployments: unpaged, an 11k+ pool deployment (checked
   * 2026-11-04) exceeds the view-call gas limit (`GasLimitExceeded`).
   */
  async listPools(page?: {
    readonly fromIndex: number;
    readonly limit: number;
  }): Promise<DclPool[]> {
    const args = page ? { from_index: page.fromIndex, limit: page.limit } : undefined;
    return this.read('list_pools', args, poolListSchema);
  }

  /** `get_liquidity { lpt_id }` - one position. */
  async getPosition(lptId: string): Promise<DclPosition | null> {
    return this.read('get_liquidity', { lpt_id: lptId }, liquidityInfoSchema.nullable());
  }

  /** `list_liquidities { account_id }` - all positions owned by the account. */
  async listPositions(accountId: AccountId): Promise<DclPosition[]> {
    return this.read('list_liquidities', { account_id: accountId }, positionListSchema);
  }

  /** `list_user_assets { account_id }` - balances held INSIDE the DCL contract (deposited, not yet withdrawn). */
  async listInternalBalances(accountId: AccountId): Promise<ReadonlyMap<string, bigint>> {
    const assets = await this.read('list_user_assets', { account_id: accountId }, userAssetsSchema);
    return new Map(Object.entries(assets ?? {}));
  }

  /** `get_marketdepth { pool_id, depth }` (ref-ui uses depth 100). */
  async getMarketDepth(poolId: string, depth = 100): Promise<DclMarketDepth> {
    if (!Number.isInteger(depth) || depth <= 0)
      throw new RangeError('depth must be a positive integer');
    return this.read(
      'get_marketdepth',
      { pool_id: normalisePoolId(poolId), depth },
      marketDepthSchema,
    );
  }

  /** `quote { pool_ids, input_token, output_token, input_amount, tag }`. */
  async quote(args: {
    readonly poolIds: readonly string[];
    readonly inputToken: AccountId;
    readonly outputToken: AccountId;
    readonly inputAmount: bigint;
    readonly tag?: string;
  }): Promise<DclQuote> {
    if (args.poolIds.length === 0) throw new RangeError('poolIds must not be empty');
    if (args.inputAmount <= 0n) throw new RangeError('inputAmount must be positive');
    return this.read(
      'quote',
      {
        pool_ids: args.poolIds.map(normalisePoolId),
        input_token: args.inputToken,
        output_token: args.outputToken,
        input_amount: args.inputAmount.toString(),
        tag: args.tag,
      },
      quoteSchema,
    );
  }

  /** `quote_by_output { pool_ids, input_token, output_token, output_amount }`. */
  async quoteByOutput(args: {
    readonly poolIds: readonly string[];
    readonly inputToken: AccountId;
    readonly outputToken: AccountId;
    readonly outputAmount: bigint;
  }): Promise<DclQuote> {
    if (args.poolIds.length === 0) throw new RangeError('poolIds must not be empty');
    if (args.outputAmount <= 0n) throw new RangeError('outputAmount must be positive');
    return this.read(
      'quote_by_output',
      {
        pool_ids: args.poolIds.map(normalisePoolId),
        input_token: args.inputToken,
        output_token: args.outputToken,
        output_amount: args.outputAmount.toString(),
      },
      quoteSchema,
    );
  }

  /** `get_order { order_id }`. */
  async getOrder(orderId: string): Promise<DclOrder | null> {
    return this.read('get_order', { order_id: orderId }, orderInfoSchema.nullable());
  }

  /** `find_order { account_id, pool_id, point }`. */
  async findOrder(args: {
    readonly accountId: AccountId;
    readonly poolId: string;
    readonly point: number;
  }): Promise<DclOrder | null> {
    return this.read(
      'find_order',
      { account_id: args.accountId, pool_id: normalisePoolId(args.poolId), point: args.point },
      orderInfoSchema.nullable(),
    );
  }

  /** `list_active_orders { account_id }`. */
  async listActiveOrders(accountId: AccountId): Promise<DclOrder[]> {
    return this.read('list_active_orders', { account_id: accountId }, orderListSchema);
  }

  /** `list_history_orders { account_id }`. */
  async listHistoryOrders(accountId: AccountId): Promise<DclOrder[]> {
    return this.read('list_history_orders', { account_id: accountId }, orderListSchema);
  }

  /** `get_user_storage_detail { user_id }` - null means the account has never registered on the DCL contract. */
  async getUserStorageDetail(accountId: AccountId): Promise<DclUserStorageDetail> {
    return this.read('get_user_storage_detail', { user_id: accountId }, userStorageDetailSchema);
  }

  /** `storage_balance_of { account_id }` (NEP-145 on the DCL contract). */
  async getStorageBalance(
    accountId: AccountId,
  ): Promise<{ total: bigint; available: bigint } | null> {
    const result = await this.read(
      'storage_balance_of',
      { account_id: accountId },
      storageBalanceSchema,
    );
    return result ? { total: result.total, available: result.available } : null;
  }

  /** `get_metadata` - contract-level metadata; returned unparsed because no consumer reads fixed fields from it. */
  async getMetadata(): Promise<unknown> {
    return this.viewer.view(this.contractId, 'get_metadata');
  }
}
