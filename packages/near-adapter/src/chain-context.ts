import type { AccountId, ChainContext, ChainContextProvider } from '@near-autopilot/core';
import { UnexpectedResponseError } from '@near-autopilot/core';
import { z } from 'zod';
import type { NearRpcClient } from './rpc-client';

const accessKeySchema = z.object({
  nonce: z.number().int().nonnegative(),
  block_hash: z.string().min(32),
  permission: z.union([
    z.literal('FullAccess'),
    z.object({
      FunctionCall: z.object({
        receiver_id: z.string(),
        method_names: z.array(z.string()),
        allowance: z.string().regex(/^\d+$/).nullable(),
      }),
    }),
  ]),
});

export class NearChainContextProvider implements ChainContextProvider {
  constructor(private readonly rpc: NearRpcClient) {}

  /** One round trip: the access-key query returns both the current nonce and a recent final block hash. */
  async getContext(signerId: AccountId, publicKey: string): Promise<ChainContext> {
    const raw = await this.rpc.call('query', {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: signerId,
      public_key: publicKey,
    });
    const parsed = accessKeySchema.safeParse(raw);
    if (!parsed.success) {
      throw new UnexpectedResponseError(
        `view_access_key:${signerId}`,
        'malformed response (is the key registered?)',
      );
    }
    const p = parsed.data.permission;
    return {
      nonce: BigInt(parsed.data.nonce) + 1n,
      blockHash: parsed.data.block_hash,
      permission:
        p === 'FullAccess'
          ? { kind: 'full_access' }
          : {
              kind: 'function_call',
              receiverId: p.FunctionCall.receiver_id,
              methodNames: p.FunctionCall.method_names,
              allowance:
                p.FunctionCall.allowance === null ? null : BigInt(p.FunctionCall.allowance),
            },
    };
  }
}
