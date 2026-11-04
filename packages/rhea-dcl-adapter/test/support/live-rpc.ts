import type { AccountId, ContractViewer } from '@near-autopilot/core';
import type { JsonRpcCaller } from '../../src';

/**
 * Tiny fetch-based NEAR JSON-RPC client for LIVE tests only. Duplicated on purpose: adapters may not
 * import each other (boundaries.config.mjs), and production wiring uses near-adapter's NearRpcClient,
 * which satisfies the same `JsonRpcCaller` shape.
 */
export class LiveRpc implements JsonRpcCaller, ContractViewer {
  private id = 0;

  constructor(private readonly url: string) {}

  async call(method: string, params: unknown): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: (this.id += 1), method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`RPC ${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  async view(
    contractId: AccountId,
    methodName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const result = (await this.call('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    })) as { result?: number[]; error?: string };
    if (result.error) throw new Error(`${contractId}#${methodName}: ${result.error}`);
    const bytes = result.result ?? [];
    return bytes.length === 0 ? null : (JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
  }
}
