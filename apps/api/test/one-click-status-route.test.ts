import { describe, expect, it } from 'vitest';
import {
  EXPIRY_GRACE_MS,
  STATUS_CACHE_MS,
  STATUS_CACHE_SIZE,
  type DepositDeps,
  type StoredDepositQuote,
} from '../src/analytics/deposit';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import type { SwapStatus, SwapStatusReport } from '../src/gateway/one-click-deposit';

const API_TOKEN = 'public-token-public-token-public-token-1';
const DEPOSIT = '0x76b4c56085ed136a8744d52be956396624a730e8';
const NEAR_TX = '7Ytp5ZTdDuEe8VbWbkxhV5mBvRcP4tH8u6uJYHzdGMqd';

const stored = (id: string): StoredDepositQuote => ({
  id,
  createdAt: new Date('2026-11-13T10:00:00Z'),
  accountId: 'alice.near',
  originAsset: 'nep141:eth-0xa0b8.omft.near',
  destinationAsset: 'nep141:wrap.near',
  amountIn: '100000000',
  amountOut: '99750000',
  minAmountOut: '98752500',
  refundTo: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
  depositAddress: `${DEPOSIT}-${id}`,
  deadline: new Date('2026-11-14T10:00:00Z'),
  correlationId: 'c0ffee',
  signature: 'ed25519:sig',
  feeBps: 1,
});

const report = (status: SwapStatus, over: Partial<SwapStatusReport> = {}): SwapStatusReport => ({
  status,
  depositedAmount: null,
  amountOut: null,
  refundedAmount: null,
  refundReason: null,
  nearTxHash: null,
  ...over,
});

function setup(
  answer: () => Promise<SwapStatusReport> = async () => report('PENDING_DEPOSIT'),
  o: { failSave?: boolean } = {},
) {
  let clock = new Date('2026-11-13T10:01:00Z');
  const asked: string[] = [];
  const statuses: { id: string; status: string; at: Date }[] = [];
  const deposit: DepositDeps = {
    oneClick: {
      tokens: async () => [],
      quote: async () => {
        throw new Error('not used');
      },
      status: async (address) => {
        asked.push(address);
        return answer();
      },
    },
    store: {
      save: async () => undefined,
      purge: async () => undefined,
      find: async (id) =>
        id.startsWith('dq_')
          ? { ...stored(id), status: statuses.findLast((x) => x.id === id)?.status ?? null }
          : null,
      unfinished: async () => [],
      saveStatus: async (id, status, at) => {
        if (o.failSave) throw new Error('db down');
        statuses.push({ id, status, at });
      },
    },
    destinationTokens: [],
  };
  const app = buildAnalyticsServer({
    apiToken: API_TOKEN,
    store: {} as CollectorStore,
    intervalSeconds: 900,
    now: () => clock,
    deposit,
  });
  const get = (id: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/deposit/status/${id}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { get, asked, statuses, advance };
}

describe('GET /v1/deposit/status/:id', () => {
  it('asks 1Click by the stored deposit address and returns what the dialog shows', async () => {
    const { get, asked } = setup(async () =>
      report('SUCCESS', {
        depositedAmount: 100_000_000n,
        amountOut: 99_700_000n,
        refundedAmount: 0n,
        nearTxHash: NEAR_TX,
      }),
    );
    const res = await get('dq_1');
    expect(res.statusCode).toBe(200);
    expect(asked).toEqual([`${DEPOSIT}-dq_1`]);
    expect(res.json()).toEqual({
      status: 'SUCCESS',
      depositedAmount: '100000000',
      amountOut: '99700000',
      refundedAmount: '0',
      refundReason: null,
      nearTxHash: NEAR_TX,
      deadlinePassed: false,
    });
  });

  it('answers 404 for an unknown quote id without asking 1Click', async () => {
    const { get, asked } = setup();
    expect((await get('nope')).statusCode).toBe(404);
    expect((await get('dq_%2F..')).statusCode).toBe(400);
    expect(asked).toEqual([]);
  });

  it('serves many tabs on one quote from one 1Click call per few seconds', async () => {
    const { get, asked, advance } = setup();
    await Promise.all([get('dq_1'), get('dq_1'), get('dq_1')]);
    advance(STATUS_CACHE_MS - 1);
    await get('dq_1');
    expect(asked).toHaveLength(1);
    advance(1);
    await get('dq_1');
    expect(asked).toHaveLength(2);
  });

  it('saves the status and the check time on every check', async () => {
    let status: SwapStatus = 'PENDING_DEPOSIT';
    const { get, statuses, advance } = setup(async () => report(status));
    await get('dq_1');
    advance(STATUS_CACHE_MS);
    await get('dq_1');
    status = 'PROCESSING';
    advance(STATUS_CACHE_MS);
    await get('dq_1');
    expect(statuses.map((s) => [s.status, s.at.toISOString()])).toEqual([
      ['PENDING_DEPOSIT', '2026-11-13T10:01:00.000Z'],
      [
        'PENDING_DEPOSIT',
        new Date(Date.parse('2026-11-13T10:01:00Z') + STATUS_CACHE_MS).toISOString(),
      ],
      [
        'PROCESSING',
        new Date(Date.parse('2026-11-13T10:01:00Z') + 2 * STATUS_CACHE_MS).toISOString(),
      ],
    ]);
  });

  it('still answers the status when storing it fails', async () => {
    const { get } = setup(async () => report('SUCCESS'), { failSave: true });
    const res = await get('dq_1');
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('SUCCESS');
  });

  it('answers 502 with our own words when 1Click fails, and asks again next time', async () => {
    let fail = true;
    const { get, asked } = setup(async () => {
      if (fail) throw new Error('HTTP 500 from upstream with secret text');
      return report('PENDING_DEPOSIT');
    });
    const res = await get('dq_1');
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret');
    fail = false;
    expect((await get('dq_1')).statusCode).toBe(200);
    expect(asked).toHaveLength(2);
  });

  it('says from the server clock when the deadline and its grace have passed', async () => {
    const { get, advance } = setup();
    advance(24 * 60 * 60_000 - 60_000 + EXPIRY_GRACE_MS - 1);
    expect((await get('dq_1')).json<{ deadlinePassed: boolean }>().deadlinePassed).toBe(false);
    advance(STATUS_CACHE_MS);
    expect((await get('dq_1')).json<{ deadlinePassed: boolean }>().deadlinePassed).toBe(true);
  });

  it('keeps a bounded cache: the oldest quote is dropped first', async () => {
    const { get, asked } = setup();
    for (let i = 0; i <= STATUS_CACHE_SIZE; i++) await get(`dq_${i}`);
    await get(`dq_${STATUS_CACHE_SIZE}`);
    expect(asked).toHaveLength(STATUS_CACHE_SIZE + 1);
    await get('dq_0');
    expect(asked).toHaveLength(STATUS_CACHE_SIZE + 2);
  });
});
