import { UnexpectedResponseError, type AccountId, type ContractViewer } from '@near-autopilot/core';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { z } from 'zod';
import type { BlockRef } from './model';

const blockSchema = z.object({
  header: z.object({
    height: z.number().int().positive(),
    timestamp_nanosec: z.string().regex(/^\d+$/),
  }),
});

const callFunctionResult = z.object({
  result: z.array(z.number().int().min(0).max(255)).optional(),
  error: z.string().optional(),
});

/** The latest FINAL block: every view of one yield report is read at it, so the report is one consistent state. */
export async function finalBlock(rpc: Pick<NearRpcClient, 'call'>): Promise<BlockRef> {
  const parsed = blockSchema.safeParse(await rpc.call('block', { finality: 'final' }));
  if (!parsed.success) throw new UnexpectedResponseError('block', 'malformed block header');
  return {
    height: parsed.data.header.height,
    timestamp: new Date(Number(BigInt(parsed.data.header.timestamp_nanosec) / 1_000_000n)),
  };
}

/** ContractViewer pinned to one block height (read-only `call_function` views; nothing is ever signed). */
export class PinnedViewer implements ContractViewer {
  constructor(
    private readonly rpc: Pick<NearRpcClient, 'call'>,
    readonly block: BlockRef,
  ) {}

  async view(
    contractId: AccountId,
    methodName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const raw = await this.rpc.call('query', {
      request_type: 'call_function',
      block_id: this.block.height,
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    });
    const source = `${contractId}#${methodName}@${this.block.height}`;
    const parsed = callFunctionResult.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(source, 'malformed call_function result');
    if (parsed.data.error) throw new UnexpectedResponseError(source, parsed.data.error);
    const bytes = parsed.data.result ?? [];
    if (bytes.length === 0) return null;
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
    } catch (cause) {
      throw new UnexpectedResponseError(source, 'contract returned non-JSON bytes', { cause });
    }
  }
}
