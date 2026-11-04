import { describe, expect, it } from 'vitest';
import { accountId, RpcError } from '@near-autopilot/core';
import {
  NearAccountReader,
  NearChainContextProvider,
  NearContractViewer,
  NearRpcClient,
  NearTransactionBroadcaster,
} from '../src';

interface Recorded {
  method: string;
  params: Record<string, unknown>;
}

/** HTTP-level stub: stands in for the network, not for the chain. Responses are JSON-RPC shaped. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  let i = 0;
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected JSON-RPC request body to be a string');
    }
    const payload = JSON.parse(init.body) as Recorded;
    requests.push({ method: payload.method, params: payload.params });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(next?.body), { status: next?.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const client = (fetchImpl: typeof fetch, maxRetries = 2) =>
  new NearRpcClient({ url: 'http://rpc.invalid', fetchImpl, maxRetries, sleep: async () => {} });

const bytes = (value: unknown): number[] => [...Buffer.from(JSON.stringify(value), 'utf8')];

describe('NearContractViewer', () => {
  it('encodes args as base64 and decodes JSON result bytes', async () => {
    const { fetchImpl, requests } = stubFetch([
      { body: { result: { result: bytes('42'), logs: [] } } },
    ]);
    const viewer = new NearContractViewer(client(fetchImpl));
    const out = await viewer.view(accountId('wrap.near'), 'ft_balance_of', {
      account_id: 'alice.near',
    });
    expect(out).toBe('42');
    const params = requests[0]?.params as Record<string, string>;
    expect(params['request_type']).toBe('call_function');
    expect(params['method_name']).toBe('ft_balance_of');
    expect(Buffer.from(params['args_base64'] ?? '', 'base64').toString()).toBe(
      '{"account_id":"alice.near"}',
    );
  });

  it('surfaces contract-level errors returned inside result', async () => {
    const { fetchImpl } = stubFetch([{ body: { result: { error: 'wasm execution failed' } } }]);
    const viewer = new NearContractViewer(client(fetchImpl));
    await expect(viewer.view(accountId('wrap.near'), 'boom')).rejects.toThrow(
      'wasm execution failed',
    );
  });

  it('returns null for empty results', async () => {
    const { fetchImpl } = stubFetch([{ body: { result: { result: [] } } }]);
    const viewer = new NearContractViewer(client(fetchImpl));
    expect(await viewer.view(accountId('wrap.near'), 'get_account')).toBeNull();
  });
});

describe('NearRpcClient retry policy', () => {
  it('retries idempotent calls on 5xx and then succeeds', async () => {
    const { fetchImpl, requests } = stubFetch([
      { status: 503, body: {} },
      { body: { result: { ok: true } } },
    ]);
    expect(await client(fetchImpl).call('status', [])).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('never retries non-idempotent calls', async () => {
    const { fetchImpl, requests } = stubFetch([
      { status: 503, body: {} },
      { body: { result: {} } },
    ]);
    await expect(client(fetchImpl).call('send_tx', {}, { idempotent: false })).rejects.toThrow(
      RpcError,
    );
    expect(requests).toHaveLength(1);
  });

  it('turns JSON-RPC error envelopes into RpcError', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'nope' },
        },
      },
    ]);
    await expect(client(fetchImpl).call('query', {})).rejects.toThrow('UNKNOWN_ACCOUNT');
  });
});

describe('NearAccountReader', () => {
  it('subtracts the storage reserve from the liquid balance', async () => {
    const amount = (5n * 10n ** 24n).toString();
    const { fetchImpl } = stubFetch([
      { body: { result: { amount, locked: '0', storage_usage: 1000 } } },
    ]);
    const balance = await new NearAccountReader(client(fetchImpl)).getNativeBalance(
      accountId('alice.near'),
    );
    expect(balance).toBe(5n * 10n ** 24n - 1000n * 10n ** 19n);
  });
});

describe('NearChainContextProvider', () => {
  it('returns nonce + 1 and the block hash', async () => {
    const hash = 'H'.repeat(44);
    const { fetchImpl } = stubFetch([
      { body: { result: { nonce: 100, block_hash: hash, permission: 'FullAccess' } } },
    ]);
    const ctx = await new NearChainContextProvider(client(fetchImpl)).getContext(
      accountId('alice.near'),
      'ed25519:abc',
    );
    expect(ctx).toEqual({ nonce: 101n, blockHash: hash });
  });
});

describe('NearTransactionBroadcaster', () => {
  const signed = { hash: 'HASH', payloadBase64: 'AAAA' };
  const ok = { SuccessValue: '' };

  it('reports success when every receipt succeeds', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          result: {
            status: ok,
            transaction: { hash: 'HASH' },
            receipts_outcome: [{ id: 'r1', outcome: { status: ok } }],
          },
        },
      },
    ]);
    const res = await new NearTransactionBroadcaster(client(fetchImpl)).broadcast(
      signed,
      accountId('alice.near'),
    );
    expect(res).toEqual({ txHash: 'HASH', status: 'success', failureReason: null });
  });

  it('reports failure when a downstream receipt fails even if the first succeeded', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          result: {
            status: ok,
            transaction: { hash: 'HASH' },
            receipts_outcome: [
              { id: 'r1', outcome: { status: ok } },
              {
                id: 'r2',
                outcome: { status: { Failure: { ActionError: { kind: 'FunctionCallError' } } } },
              },
            ],
          },
        },
      },
    ]);
    const res = await new NearTransactionBroadcaster(client(fetchImpl)).broadcast(
      signed,
      accountId('alice.near'),
    );
    expect(res.status).toBe('failure');
    expect(res.failureReason).toContain('r2');
  });

  it('warns that the outcome is unknown when the broadcast request itself fails', async () => {
    const { fetchImpl } = stubFetch([{ status: 502, body: {} }]);
    await expect(
      new NearTransactionBroadcaster(client(fetchImpl)).broadcast(signed, accountId('alice.near')),
    ).rejects.toThrow('may or may not have landed');
  });
});
