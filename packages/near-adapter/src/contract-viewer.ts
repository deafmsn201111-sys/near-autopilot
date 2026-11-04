import type { AccountId, ContractViewer } from '@near-autopilot/core';
import { UnexpectedResponseError } from '@near-autopilot/core';
import { z } from 'zod';
import type { NearRpcClient } from './rpc-client';

const callFunctionResult = z.object({
  result: z.array(z.number().int().min(0).max(255)).optional(),
  error: z.string().optional(),
});

/** ContractViewer over the `query`/`call_function` RPC. Reads at `final` finality. */
export class NearContractViewer implements ContractViewer {
  constructor(private readonly rpc: NearRpcClient) {}

  async view(
    contractId: AccountId,
    methodName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const raw = await this.rpc.call('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    });
    const parsed = callFunctionResult.safeParse(raw);
    const source = `${contractId}#${methodName}`;
    if (!parsed.success)
      throw new UnexpectedResponseError(source, 'malformed call_function result');
    if (parsed.data.error) throw new UnexpectedResponseError(source, parsed.data.error);
    const bytes = parsed.data.result ?? [];
    if (bytes.length === 0) return null;
    const text = Buffer.from(bytes).toString('utf8');
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new UnexpectedResponseError(source, 'contract returned non-JSON bytes', { cause });
    }
  }
}
