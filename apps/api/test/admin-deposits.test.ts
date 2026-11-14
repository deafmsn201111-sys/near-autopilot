import { describe, expect, it } from 'vitest';
import {
  depositsSummary,
  type AdminDepositRow,
  type AdminDepositStore,
} from '../src/analytics/admin-deposits';
import type { AdminStore } from '../src/analytics/admin';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import type { OneClickToken } from '../src/gateway/one-click-deposit';

const NOW = new Date('2026-11-12T10:00:00Z');
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const TOKENS: OneClickToken[] = [
  {
    assetId: USDC_ETH,
    decimals: 6,
    blockchain: 'eth',
    symbol: 'USDC',
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  },
];

const row = (over: Partial<AdminDepositRow>): AdminDepositRow => ({
  id: 'q',
  createdAt: new Date('2026-11-12T09:00:00Z'),
  accountId: 'alice.near',
  originAsset: USDC_ETH,
  amountIn: '1500000',
  refundTo: '0x1111111111111111111111111111111111112222',
  depositAddress: '0x3333333333333333333333333333333333334444',
  deadline: new Date('2026-11-13T09:00:00Z'),
  feeBps: 10,
  status: null,
  statusAt: null,
  ...over,
});

const ROWS = [
  row({ id: 'waiting-unchecked' }),
  row({
    id: 'waiting',
    status: 'PENDING_DEPOSIT',
    statusAt: new Date('2026-11-12T09:30:00Z'),
  }),
  row({ id: 'expired', status: 'PENDING_DEPOSIT', deadline: new Date('2026-11-12T09:29:00Z') }),
  row({ id: 'expired-unchecked', deadline: new Date('2026-11-11T00:00:00Z') }),
  row({ id: 'in-grace', deadline: new Date('2026-11-12T09:31:00Z') }),
  row({ id: 'processing', status: 'KNOWN_DEPOSIT_TX' }),
  row({ id: 'incomplete', status: 'INCOMPLETE_DEPOSIT' }),
  row({ id: 'success', status: 'SUCCESS' }),
  row({ id: 'refunded', status: 'REFUNDED' }),
  row({ id: 'failed', status: 'FAILED' }),
  row({ id: 'old', status: 'SUCCESS', createdAt: new Date('2026-11-05T23:59:59Z') }),
];

describe('depositsSummary', () => {
  it('counts the last 7 UTC days by status; unpaid past the deadline plus grace is expired', () => {
    expect(depositsSummary(ROWS, TOKENS, NOW).counts).toEqual({
      waiting: 3,
      processing: 2,
      success: 1,
      refunded: 1,
      failed: 1,
      expired: 2,
    });
  });

  it('lists quotes newest first with the token, a readable amount and shortened addresses', () => {
    const rows = [
      row({ id: 'older', createdAt: new Date('2026-11-11T00:00:00Z') }),
      row({ id: 'newer', status: 'SUCCESS', statusAt: new Date('2026-11-12T09:45:00Z') }),
    ];
    const { quotes } = depositsSummary(rows, TOKENS, NOW);
    expect(quotes.map((q) => q.id)).toEqual(['newer', 'older']);
    expect(quotes[0]).toEqual({
      id: 'newer',
      createdAt: '2026-11-12T09:00:00.000Z',
      accountId: 'alice.near',
      chain: 'eth',
      asset: 'USDC',
      amount: '1.5',
      depositAddress: '0x3333…4444',
      refundTo: '0x1111…2222',
      deadline: '2026-11-13T09:00:00.000Z',
      feeBps: 10,
      status: 'SUCCESS',
      state: 'success',
      statusAt: '2026-11-12T09:45:00.000Z',
    });
  });

  it('never returns a refund address in full', () => {
    const body = JSON.stringify(depositsSummary(ROWS, TOKENS, NOW));
    expect(body).not.toContain('0x1111111111111111111111111111111111112222');
    expect(body).not.toContain('0x3333333333333333333333333333333333334444');
  });

  it('shows the raw asset id and base units when 1Click lists no such token', () => {
    const [q] = depositsSummary([row({})], [], NOW).quotes;
    expect(q).toMatchObject({ chain: null, asset: USDC_ETH, amount: '1500000' });
  });

  it('keeps at most 100 quotes in the list but counts all of them', () => {
    const many = Array.from({ length: 120 }, (_, i) => row({ id: `q${i}` }));
    const s = depositsSummary(many, TOKENS, NOW);
    expect(s.quotes).toHaveLength(100);
    expect(s.counts.waiting).toBe(120);
  });
});

const API_TOKEN = 'public-token-public-token-public-token-1';
const ADMIN_TOKEN = 'admin-token-admin-token-admin-token-admin-1';
const noSpend = {} as AdminStore;

const server = (deposits: AdminDepositStore, tokens = async () => TOKENS) =>
  buildAnalyticsServer({
    apiToken: API_TOKEN,
    store: {} as CollectorStore,
    intervalSeconds: 900,
    now: () => NOW,
    admin: {
      token: ADMIN_TOKEN,
      store: noSpend,
      defaultCapMicro: 5_000_000n,
      deposits: { store: deposits, tokens },
    },
  });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('/v1/admin/deposits', () => {
  it('reads the 7-day window and answers only the admin token', async () => {
    const since: Date[] = [];
    const app = server({ recent: async (s) => (since.push(s), [row({})]) });
    for (const headers of [{}, bearer(API_TOKEN)]) {
      const res = await app.inject({ url: '/v1/admin/deposits', headers });
      expect(res.statusCode).toBe(401);
    }
    const ok = await app.inject({ url: '/v1/admin/deposits', headers: bearer(ADMIN_TOKEN) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ counts: { waiting: 1 }, quotes: [{ asset: 'USDC' }] });
    expect(since).toEqual([new Date('2026-11-06T00:00:00Z')]);
  });

  it('still lists the quotes when the 1Click token list is down', async () => {
    const app = server({ recent: async () => [row({})] }, async () => {
      throw new Error('1Click down');
    });
    const res = await app.inject({ url: '/v1/admin/deposits', headers: bearer(ADMIN_TOKEN) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ quotes: unknown[] }>().quotes[0]).toMatchObject({
      asset: USDC_ETH,
      amount: '1500000',
    });
  });

  it('answers an empty store with no quotes and zero counts', async () => {
    const res = await server({ recent: async () => [] }).inject({
      url: '/v1/admin/deposits',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(res.json()).toEqual({
      counts: { waiting: 0, processing: 0, success: 0, refunded: 0, failed: 0, expired: 0 },
      quotes: [],
    });
  });
});
