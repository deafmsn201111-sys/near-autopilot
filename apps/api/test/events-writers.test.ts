import { describe, expect, it } from 'vitest';
import { accountId } from '@near-autopilot/core';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import { assembleCascade } from '../src/wallet/cascade';
import { sealCascade } from '../src/wallet/seal';
import { MemoryEventStore } from './support/memory-events';

const ALICE = accountId('alice.near');
const WRAP = accountId('wrap.near');
const TOKEN = 'events-writers-token-events-writers-token-1';

const unwrapCascade = (methodName: string) =>
  assembleCascade(ALICE, [
    {
      intentId: 'unwrap',
      tx: {
        receiverId: WRAP,
        actions: [
          {
            type: 'FunctionCall',
            methodName,
            args: { amount: '1000' },
            gas: 10_000_000_000_000n,
            deposit: 1n,
          },
        ],
      },
      preview: 'Unwrap 0.000000 wNEAR to native NEAR.',
    },
  ]);

describe('sealCascade', () => {
  it('stores an allowed cascade as prepare with its checks and the steps to match', async () => {
    const events = new MemoryEventStore();
    const r = await sealCascade(
      (e) => events.add(e).then(() => undefined),
      ALICE,
      { action: 'unwrap' },
      unwrapCascade('near_withdraw'),
      { signerId: ALICE, allowedReceivers: new Set([WRAP]) },
    );
    expect(r.ok).toBe(true);
    const [row] = events.rows;
    expect(row).toMatchObject({
      kind: 'prepare',
      verdict: 'ALLOW',
      accountId: ALICE,
      source: 'server',
      cascadeId: r.ok ? r.cascadeId : '',
      intent: { action: 'unwrap' },
      detail: {
        steps: [{ intentId: 'unwrap', receiverId: WRAP, methods: ['near_withdraw'] }],
        preview: ['Unwrap 0.000000 wNEAR to native NEAR.'],
      },
    });
    expect(row?.checks?.every((c) => (c as { pass: boolean }).pass)).toBe(true);
  });

  it('stores a cascade that failed validation as prepare_blocked with the failed check', async () => {
    const events = new MemoryEventStore();
    const r = await sealCascade(
      (e) => events.add(e).then(() => undefined),
      ALICE,
      { action: 'unwrap' },
      unwrapCascade('delete_account'),
      { signerId: ALICE, allowedReceivers: new Set([WRAP]) },
    );
    expect(r).toMatchObject({ ok: false });
    expect(events.rows[0]).toMatchObject({ kind: 'prepare_blocked', verdict: 'BLOCK' });
    const failed = (events.rows[0]?.checks as { rule: string; pass: boolean }[]).filter(
      (c) => !c.pass,
    );
    expect(failed.map((c) => c.rule)).toEqual(['methods']);
  });
});

describe('POST /v1/wallet/prepare writes its verdict', () => {
  it('a prepared unwrap leaves one prepare row and returns the cascade id', async () => {
    const events = new MemoryEventStore();
    const balance = [...Buffer.from(JSON.stringify('2000000000000000000000000'))];
    const app = buildAnalyticsServer({
      apiToken: TOKEN,
      store: {
        latestSnapshot: async () => ({
          id: 1,
          summary: { prices: [{ token: 'wrap.near', usd: '3', quality: 'OK' }] },
        }),
        pricesForSnapshot: async () => [],
      } as unknown as CollectorStore,
      intervalSeconds: 900,
      events,
      mainnet: {
        rpc: { call: async () => ({ result: balance }) } as unknown as NearRpcClient,
        burrowId: accountId('contract.main.burrow.near'),
        rheaId: accountId('v2.ref-finance.near'),
        pools: [],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/wallet/prepare',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { account: ALICE, intent: { action: 'unwrap', approxUsd: 3 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ cascadeId: string; transactions: unknown[] }>();
    expect(body.transactions).toHaveLength(1);
    expect(events.rows).toEqual([
      expect.objectContaining({ kind: 'prepare', cascadeId: body.cascadeId, accountId: ALICE }),
    ]);
  });
});
