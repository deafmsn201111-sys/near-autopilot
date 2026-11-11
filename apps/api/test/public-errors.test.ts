import { describe, expect, it } from 'vitest';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';

const TOKEN = 'errors-token-errors-token-errors-token-1';
const auth = { authorization: `Bearer ${TOKEN}` };
const UPSTREAM = 'upstream 503 <html>internal-rpc.example:3030 stack at Foo.bar</html>';

const failingRpc = (message: string) =>
  new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error(message);
      },
    },
  ) as NearRpcClient;

const server = (message: string) =>
  buildAnalyticsServer({
    apiToken: TOKEN,
    store: {} as CollectorStore,
    intervalSeconds: 900,
    mainnet: {
      rpc: failingRpc(message),
      burrowId: 'contract.main.burrow.near',
      rheaId: 'v2.ref-finance.near',
      pools: [],
    } as never,
  });

describe('public error messages', () => {
  it('an upstream failure returns a generic message, never the upstream text', async () => {
    const res = await server(UPSTREAM).inject({
      url: '/v1/analytics/account/alice.near',
      headers: auth,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'could not read the account from NEAR right now' });
  });

  it('a missing account still says so plainly', async () => {
    const res = await server('account nobody.near does not exist while viewing').inject({
      url: '/v1/analytics/account/nobody.near',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'account nobody.near does not exist on NEAR mainnet' });
  });

  it('a failed prepare returns a generic message, never the upstream text', async () => {
    const res = await server(UPSTREAM).inject({
      method: 'POST',
      url: '/v1/wallet/prepare',
      headers: auth,
      payload: { account: 'alice.near', intent: { action: 'unwrap', approxUsd: 10 } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'could not prepare the transaction right now' });
  });

  it('a failed database check reports it is down, not the driver text', async () => {
    const db = {
      execute: async () => {
        throw new Error('connect ECONNREFUSED 172.18.0.2:5432');
      },
    };
    const app = buildAnalyticsServer({
      apiToken: TOKEN,
      store: { db, recentCycles: async () => [] } as unknown as CollectorStore,
      intervalSeconds: 900,
    });
    const res = await app.inject({ url: '/v1/analytics/system', headers: auth });
    expect(res.json<{ database: unknown }>().database).toEqual({
      ok: false,
      latencyMs: null,
      migrations: null,
      error: 'the database is unreachable',
    });
  });

  it('an unhandled crash returns a generic 500 without the message or stack', async () => {
    const app = server(UPSTREAM);
    app.get('/v1/boom', async () => {
      throw new Error(UPSTREAM);
    });
    const res = await app.inject({ url: '/v1/boom', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error' });
  });

  it('a client error keeps its own message', async () => {
    const app = server(UPSTREAM);
    app.post('/v1/echo', async (req) => req.body);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/json/i);
  });
});
