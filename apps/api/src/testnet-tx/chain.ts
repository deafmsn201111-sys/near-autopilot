import { fetchDeployedAbi, RpcError, type AccountId } from '@near-autopilot/core';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { z } from 'zod';

/** Read-only chain access the testnet transaction tool needs. Every method is a view: none can move funds. */
export interface TestnetChainReader {
  status(): Promise<{ chainId: string; blockHeight: number }>;
  account(id: AccountId): Promise<{ amount: bigint; locked: bigint; storageUsage: bigint } | null>;
  /** null when the key is not registered on the account. */
  accessKey(
    id: AccountId,
    publicKey: string,
  ): Promise<{ nonce: bigint; blockHash: string; fullAccess: boolean } | null>;
  view(contract: AccountId, method: string, args: Record<string, unknown>): Promise<unknown>;
  exports(contract: AccountId): Promise<readonly string[]>;
  gasPrice(): Promise<bigint>;
  /** Final outcome of a sent transaction; `not_found` if the node does not (yet) know it. */
  txOutcome(hash: string, sender: AccountId): Promise<TxOutcome>;
}

export type TxOutcome =
  | { readonly kind: 'not_found' }
  /** Known to the node but not final yet. */
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'final';
      readonly success: boolean;
      readonly failure: string | null;
      readonly tokensBurntYocto: bigint;
    };

const u128 = z.string().regex(/^\d+$/).transform(BigInt);
const accountView = z.object({
  amount: u128,
  locked: u128,
  storage_usage: z.number().int().nonnegative(),
});
const accessKeyView = z.object({
  nonce: z.number().int().nonnegative(),
  block_hash: z.string().min(32),
  permission: z.union([z.literal('FullAccess'), z.object({ FunctionCall: z.unknown() })]),
});
const statusView = z.object({
  chain_id: z.string(),
  sync_info: z.object({ latest_block_height: z.number().int() }),
});
const outcomeStatus = z.union([
  z.object({ SuccessValue: z.string() }).passthrough(),
  z.object({ SuccessReceiptId: z.string() }).passthrough(),
  z.object({ Failure: z.unknown() }).passthrough(),
  z.literal('Unknown'),
  z.object({ Unknown: z.unknown() }).passthrough(),
]);
const execOutcome = z.object({
  outcome: z.object({ tokens_burnt: u128, status: outcomeStatus }).passthrough(),
});
const txView = z
  .object({
    status: outcomeStatus,
    transaction_outcome: execOutcome,
    receipts_outcome: z.array(execOutcome).default([]),
  })
  .passthrough();

const isFailure = (s: z.infer<typeof outcomeStatus>): s is { Failure: unknown } =>
  typeof s === 'object' && 'Failure' in s;

/** View methods only. `send_tx` is NOT here: sending goes through the broadcaster, exactly once. */
export class RpcTestnetChainReader implements TestnetChainReader {
  constructor(private readonly rpc: NearRpcClient) {}

  async status() {
    const s = statusView.parse(await this.rpc.call('status', []));
    return { chainId: s.chain_id, blockHeight: s.sync_info.latest_block_height };
  }

  async account(id: AccountId) {
    try {
      const a = accountView.parse(
        await this.rpc.call('query', {
          request_type: 'view_account',
          finality: 'final',
          account_id: id,
        }),
      );
      return { amount: a.amount, locked: a.locked, storageUsage: BigInt(a.storage_usage) };
    } catch (error) {
      if (error instanceof RpcError && /UNKNOWN_ACCOUNT/.test(error.message)) return null;
      throw error;
    }
  }

  async accessKey(id: AccountId, publicKey: string) {
    try {
      const k = accessKeyView.parse(
        await this.rpc.call('query', {
          request_type: 'view_access_key',
          finality: 'final',
          account_id: id,
          public_key: publicKey,
        }),
      );
      return {
        nonce: BigInt(k.nonce),
        blockHash: k.block_hash,
        fullAccess: k.permission === 'FullAccess',
      };
    } catch (error) {
      if (error instanceof RpcError && /UNKNOWN_ACCESS_KEY/.test(error.message)) return null;
      throw error;
    }
  }

  async view(contract: AccountId, method: string, args: Record<string, unknown>) {
    const r = z.object({ result: z.array(z.number().int().min(0).max(255)) }).parse(
      await this.rpc.call('query', {
        request_type: 'call_function',
        finality: 'final',
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      }),
    );
    const value: unknown = JSON.parse(Buffer.from(r.result).toString('utf8'));
    return value;
  }

  async exports(contract: AccountId) {
    return [...(await fetchDeployedAbi(this.rpc, contract)).functions];
  }

  async gasPrice() {
    const r = z.object({ gas_price: u128 }).parse(await this.rpc.call('gas_price', [null]));
    return r.gas_price;
  }

  async txOutcome(hash: string, sender: AccountId): Promise<TxOutcome> {
    let raw: unknown;
    try {
      // A status query is a read: safe to retry, never re-sends anything.
      raw = await this.rpc.call('tx', {
        tx_hash: hash,
        sender_account_id: sender,
        wait_until: 'FINAL',
      });
    } catch (error) {
      if (error instanceof RpcError && /UNKNOWN_TRANSACTION/.test(error.message)) {
        return { kind: 'not_found' };
      }
      throw error;
    }
    const v = txView.parse(raw);
    const pending = (st: z.infer<typeof outcomeStatus>) =>
      st === 'Unknown' || (typeof st === 'object' && 'Unknown' in st);
    if (pending(v.status) || v.receipts_outcome.some((r) => pending(r.outcome.status))) {
      return { kind: 'pending' };
    }
    const failures = [v.status, ...v.receipts_outcome.map((r) => r.outcome.status)].filter(
      isFailure,
    );
    const burnt = [v.transaction_outcome, ...v.receipts_outcome].reduce(
      (sum, o) => sum + o.outcome.tokens_burnt,
      0n,
    );
    return {
      kind: 'final',
      success: failures.length === 0,
      failure: failures.length === 0 ? null : JSON.stringify(failures.map((f) => f.Failure)),
      tokensBurntYocto: burnt,
    };
  }
}
