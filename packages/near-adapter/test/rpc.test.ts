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

describe('NearRpcClient resilience (rate limits, timeouts, invalid responses)', () => {
  const kindOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      return error instanceof RpcError ? { kind: error.kind, retryable: error.retryable } : error;
    }
    return 'resolved';
  };

  it('retries HTTP 429 with backoff, honours Retry-After (capped), and reports each retry', async () => {
    const waits: number[] = [];
    const events: string[] = [];
    let i = 0;
    const fetchImpl: typeof fetch = async () => {
      i += 1;
      if (i === 1) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      if (i === 2) return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
      return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    };
    const rpc = new NearRpcClient({
      url: 'http://rpc.invalid',
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0,
      maxDelayMs: 10_000,
      onRetry: (e) => events.push(`${e.attempt}:${e.kind}`),
    });
    expect(await rpc.call('status', [])).toBe('ok');
    expect(waits).toEqual([2000, 10_000]);
    expect(events).toEqual(['1:rate_limit', '2:rate_limit']);
  });

  it('adds jitter to the exponential backoff', async () => {
    const waits: number[] = [];
    const { fetchImpl } = stubFetch([{ status: 503, body: {} }]);
    const rpc = new NearRpcClient({
      url: 'http://rpc.invalid',
      fetchImpl,
      maxRetries: 3,
      baseDelayMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 0.5,
    });
    await expect(rpc.call('status', [])).rejects.toThrow(RpcError);
    // exp = 100, 200, 400; equal jitter with random 0.5 -> 75%.
    expect(waits).toEqual([75, 150, 300]);
  });

  it('gives up after maxRetries and surfaces rate_limit, never a fake result', async () => {
    const { fetchImpl, requests } = stubFetch([{ status: 429, body: {} }]);
    expect(await kindOf(client(fetchImpl, 2).call('status', []))).toEqual({
      kind: 'rate_limit',
      retryable: true,
    });
    expect(requests).toHaveLength(3);
  });

  it('never retries a broadcast, even on HTTP 429 or a timeout', async () => {
    const limited = stubFetch([{ status: 429, body: {} }]);
    await expect(
      client(limited.fetchImpl).call('send_tx', {}, { idempotent: false }),
    ).rejects.toThrow(RpcError);
    expect(limited.requests).toHaveLength(1);

    let calls = 0;
    const timingOut: typeof fetch = async () => {
      calls += 1;
      throw new DOMException('timed out', 'TimeoutError');
    };
    expect(await kindOf(client(timingOut).call('send_tx', {}, { idempotent: false }))).toEqual({
      kind: 'timeout',
      retryable: true,
    });
    expect(calls).toBe(1);
  });

  it('classifies timeouts, unreachable endpoints and HTTP errors', async () => {
    const timeout: typeof fetch = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await kindOf(client(timeout, 0).call('status', []))).toEqual({
      kind: 'timeout',
      retryable: true,
    });
    expect(await kindOf(client(down, 0).call('status', []))).toEqual({
      kind: 'unavailable',
      retryable: true,
    });
    const forbidden = stubFetch([{ status: 403, body: {} }]);
    expect(await kindOf(client(forbidden.fetchImpl).call('status', []))).toEqual({
      kind: 'http_error',
      retryable: false,
    });
    expect(forbidden.requests).toHaveLength(1);
  });

  it('rejects bodies that are not JSON-RPC envelopes as invalid_response', async () => {
    const html: typeof fetch = async () => new Response('<html>busy</html>', { status: 200 });
    expect(await kindOf(client(html, 0).call('status', []))).toEqual({
      kind: 'invalid_response',
      retryable: true,
    });
    const notEnvelope = stubFetch([{ body: { jsonrpc: '2.0', id: 1 } }]);
    expect(await kindOf(client(notEnvelope.fetchImpl).call('status', []))).toEqual({
      kind: 'invalid_response',
      retryable: false,
    });
    const arrayBody = stubFetch([{ body: [1, 2] }]);
    expect(await kindOf(client(arrayBody.fetchImpl).call('status', []))).toEqual({
      kind: 'invalid_response',
      retryable: false,
    });
  });

  it('treats node-side TIMEOUT_ERROR as a transient timeout and UNKNOWN_ACCOUNT as final', async () => {
    const t = stubFetch([
      { body: { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } } },
      { body: { result: 1 } },
    ]);
    expect(await client(t.fetchImpl).call('query', {})).toBe(1);
    const u = stubFetch([
      { body: { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } } },
    ]);
    expect(await kindOf(client(u.fetchImpl).call('query', {}))).toEqual({
      kind: 'rpc_error',
      retryable: false,
    });
    expect(u.requests).toHaveLength(1);
  });

  it('bounds concurrent requests', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    };
    const rpc = new NearRpcClient({ url: 'http://rpc.invalid', fetchImpl, maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 8 }, () => rpc.call('status', [])));
    expect(peak).toBe(2);
  });
});
