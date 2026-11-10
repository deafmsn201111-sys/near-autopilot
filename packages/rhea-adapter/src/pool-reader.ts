import type { AccountId, ContractViewer, TokenId } from '@near-autopilot/core';
import { accountIdSchema, u128StringSchema, UnexpectedResponseError } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * Read-only views of the Rhea v1 (ref-exchange) contract used for LP data. Field names were checked against
 * ref-exchange v1.9.19 on 2026-11-04: `get_pool` -> PoolInfo, `get_pool_volumes` -> SwapVolume[]
 * (cumulative since the pool was created), `metadata` -> ContractMetadata (`admin_fee_bps`).
 */
const poolInfoSchema = z
  .object({
    pool_kind: z.string().min(1),
    token_account_ids: z.array(accountIdSchema).min(2),
    amounts: z.array(u128StringSchema).min(2),
    /** Basis points of each swap's input, charged as the trading fee. */
    total_fee: z.number().int().min(0).max(10_000),
    shares_total_supply: u128StringSchema,
  })
  .passthrough()
  .refine((p) => p.amounts.length === p.token_account_ids.length, {
    message: 'amounts and token_account_ids differ in length',
  });

const volumesSchema = z.array(
  z.object({ input: u128StringSchema, output: u128StringSchema }).passthrough(),
);

const metadataSchema = z
  .object({
    version: z.string(),
    state: z.string(),
    /** Share of every trading fee kept by the exchange (basis points of the fee), the rest goes to LPs. */
    admin_fee_bps: z.number().int().min(0).max(10_000),
  })
  .passthrough();

export interface RheaPoolInfo {
  readonly poolId: number;
  readonly kind: string;
  readonly tokens: readonly TokenId[];
  readonly reserves: readonly bigint[];
  readonly totalFeeBps: number;
  readonly sharesTotalSupply: bigint;
}

export interface RheaPoolVolume {
  /** Cumulative amount swapped INTO the pool in this token (raw units). */
  readonly input: bigint;
  readonly output: bigint;
}

export interface RheaExchangeMetadata {
  readonly version: string;
  readonly state: string;
  readonly adminFeeBps: number;
}

export class RheaPoolReader {
  constructor(
    private readonly viewer: ContractViewer,
    readonly contractId: AccountId,
  ) {}

  private async read<T>(
    method: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> {
    const raw = await this.viewer.view(this.contractId, method, args);
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(
        `${this.contractId}#${method}`,
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        { cause: parsed.error },
      );
    return parsed.data;
  }

  async metadata(): Promise<RheaExchangeMetadata> {
    const m = await this.read('metadata', {}, metadataSchema);
    return { version: m.version, state: m.state, adminFeeBps: m.admin_fee_bps };
  }

  /** `get_pool { pool_id }`. A missing pool makes the contract panic, which surfaces as an error. */
  async getPool(poolId: number): Promise<RheaPoolInfo> {
    const p = await this.read('get_pool', { pool_id: poolId }, poolInfoSchema);
    return {
      poolId,
      kind: p.pool_kind,
      tokens: p.token_account_ids,
      reserves: p.amounts,
      totalFeeBps: p.total_fee,
      sharesTotalSupply: p.shares_total_supply,
    };
  }

  /** `get_pool_shares { pool_id, account_id }`: the account's LP share balance in this v1 pool (0 if none). */
  async getPoolShares(poolId: number, accountId: AccountId): Promise<bigint> {
    return this.read(
      'get_pool_shares',
      { pool_id: poolId, account_id: accountId },
      u128StringSchema,
    );
  }

  /** `get_pool_volumes { pool_id }`: cumulative volumes, one entry per pool token, in pool token order. */
  async getVolumes(poolId: number): Promise<RheaPoolVolume[]> {
    const v = await this.read('get_pool_volumes', { pool_id: poolId }, volumesSchema);
    return v.map((x) => ({ input: x.input, output: x.output }));
  }
}
