import { describe, expect, it } from 'vitest';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';

const TOKEN = 'analysis-token-analysis-token-analysis-tok1';
const unreachable = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('upstream down: secret-detail');
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
    pools: [],
  } as never,
});
const headers = { authorization: `Bearer ${TOKEN}` };

describe('POST /v1/analytics/account/:id/analysis', () => {
  it('rejects an invalid account id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/account/NOT%20VALID/analysis',
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('answers a chain read failure with a generic 502', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/analytics/account/alice.near/analysis',
      headers,
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret-detail');
  });
});

describe('prepare exact amount', () => {
  it.each(['0', '-5', '1.5', '0x10', 'abc'])('rejects amount %s', async (amount) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/prepare',
      headers,
      payload: {
        account: 'alice.near',
        intent: { action: 'repay', token: 'wrap.near', approxUsd: 10, amount },
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
