import { UnexpectedResponseError } from './errors';
import type { Network } from './ids';
import type { JsonRpcCaller } from './wasm-abi';
import { z } from 'zod';

const statusSchema = z.object({ chain_id: z.string().min(1) }).passthrough();

/** The `chain_id` the RPC node reports in `status` ("mainnet", ...). */
export async function fetchChainId(rpc: JsonRpcCaller): Promise<string> {
  const raw = await rpc.call('status', []);
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) throw new UnexpectedResponseError('rpc:status', 'missing chain_id');
  return parsed.data.chain_id;
}

export class NetworkMismatchError extends Error {
  constructor(
    readonly expected: Network,
    readonly actual: string,
  ) {
    super(`RPC reports chain "${actual}" but this deployment is configured for "${expected}"`);
    this.name = 'NetworkMismatchError';
  }
}

/**
 * Fails unless the RPC node reports the expected chain. A node can lie, so this is a misconfiguration guard
 * (a config pointed at an endpoint that serves another chain), not a defence against a hostile RPC.
 */
export async function assertChainId(rpc: JsonRpcCaller, expected: Network): Promise<void> {
  const actual = await fetchChainId(rpc);
  if (actual !== expected) throw new NetworkMismatchError(expected, actual);
}
