import type {
  AccountId,
  ContractViewer,
  TokenId,
  TokenInfo,
  TokenReader,
} from '@near-autopilot/core';
import { UnexpectedResponseError, u128StringSchema } from '@near-autopilot/core';
import { z } from 'zod';

const metadataSchema = z.object({
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
});
const storageBalanceSchema = z.object({ total: z.string(), available: z.string() }).nullable();

/** NEP-141 (fungible token) and NEP-145 (storage management) reads. */
export class NearTokenReader implements TokenReader {
  private readonly metadataCache = new Map<TokenId, TokenInfo>();

  constructor(private readonly viewer: ContractViewer) {}

  async getBalance(token: TokenId, accountId: AccountId): Promise<bigint> {
    const raw = await this.viewer.view(token, 'ft_balance_of', { account_id: accountId });
    const parsed = u128StringSchema.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(`${token}#ft_balance_of`, 'expected U128 string');
    return parsed.data;
  }

  /** Token metadata is immutable in practice, so it is cached for the process lifetime. */
  async getMetadata(token: TokenId): Promise<TokenInfo> {
    const cached = this.metadataCache.get(token);
    if (cached) return cached;
    const raw = await this.viewer.view(token, 'ft_metadata');
    const parsed = metadataSchema.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(`${token}#ft_metadata`, 'malformed metadata');
    const info: TokenInfo = {
      id: token,
      symbol: parsed.data.symbol,
      decimals: parsed.data.decimals,
    };
    this.metadataCache.set(token, info);
    return info;
  }

  async isStorageRegistered(token: TokenId, accountId: AccountId): Promise<boolean> {
    const raw = await this.viewer.view(token, 'storage_balance_of', { account_id: accountId });
    const parsed = storageBalanceSchema.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(`${token}#storage_balance_of`, 'malformed response');
    return parsed.data !== null;
  }
}
