import type { AccountId, NativeBalanceReader } from '@near-autopilot/core';
import { UnexpectedResponseError, u128StringSchema } from '@near-autopilot/core';
import { z } from 'zod';
import type { NearRpcClient } from './rpc-client';

/** yoctoNEAR locked per byte of storage (protocol constant: 1e19). */
const STORAGE_BYTE_COST_YOCTO = 10n ** 19n;

const viewAccountSchema = z.object({
  amount: u128StringSchema,
  locked: u128StringSchema,
  storage_usage: z.number().int().nonnegative(),
});

export class NearAccountReader implements NativeBalanceReader {
  constructor(private readonly rpc: NearRpcClient) {}

  /** Liquid balance minus the amount reserved for storage staking. */
  async getNativeBalance(accountId: AccountId): Promise<bigint> {
    const raw = await this.rpc.call('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    const parsed = viewAccountSchema.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(`view_account:${accountId}`, 'malformed response');
    const reserved = BigInt(parsed.data.storage_usage) * STORAGE_BYTE_COST_YOCTO;
    const spendable = parsed.data.amount - reserved;
    return spendable > 0n ? spendable : 0n;
  }
}
