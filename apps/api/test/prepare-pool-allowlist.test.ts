import { describe, expect, it } from 'vitest';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';

const TOKEN = 'allowlist-token-allowlist-token-allowlist-1';
const WNEAR = 'wrap.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const unreachable = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('upstream down');
    },
  },
);

const app = buildAnalyticsServer({
  apiToken: TOKEN,
  store: unreachable as CollectorStore,
  intervalSeconds: 900,
  mainnet: {
    rpc: unreachable as NearRpcClient,
    burrowId: 'contract.main.burrow.near',
    rheaId: 'v2.ref-finance.near',
    pools: [{ poolId: 4512, tokenA: WNEAR, tokenB: USDC }],
  } as never,
});

const prepare = (poolId: number) =>
  app.inject({
    method: 'POST',
    url: '/v1/wallet/prepare',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      account: 'alice.near',
      intent: { action: 'add_liquidity', token: WNEAR, tokenOut: USDC, poolId, approxUsd: 10 },
    },
  });

describe('prepare add_liquidity pool allowlist', () => {
  it('rejects a pool that is not allowlisted before reading the chain', async () => {
    const res = await prepare(3879);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'pool 3879 is not allowlisted' });
  });

  it('lets an allowlisted pool through to the chain read', async () => {
    const res = await prepare(4512);
    expect(res.statusCode).toBe(502);
  });
});
