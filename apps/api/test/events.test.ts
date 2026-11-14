import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  activityTimeline,
  registerEvents,
  shortAccount,
  type StoredEvent,
} from '../src/analytics/events';
import { MemoryEventStore } from './support/memory-events';

const at = (min: number) => new Date(Date.UTC(2026, 10, 14, 10, min));
let id = 0;
const ev = (
  e: Omit<StoredEvent, 'id' | 'accountId' | 'source'> & Partial<StoredEvent>,
): StoredEvent => ({
  id: ++id,
  accountId: 'alice.near',
  source: 'server',
  ...e,
});

const twoSteps = {
  steps: [
    { intentId: 'repay', receiverId: 'usdc', methods: ['ft_transfer_call'] },
    { intentId: 'withdraw', receiverId: 'priceoracle.near', methods: ['oracle_call'] },
  ],
  preview: ['Repay 120 USDC', 'Withdraw 0.5 NEAR'],
};

const rows: StoredEvent[] = [
  ev({ at: at(0), kind: 'connect', source: 'client' }),
  ev({ at: at(1), kind: 'analyse', detail: { source: 'ai' } }),
  ev({
    at: at(2),
    kind: 'prepare',
    cascadeId: 'c1',
    intent: { action: 'repay' },
    detail: twoSteps,
  }),
  ev({
    at: at(3),
    kind: 'signed',
    source: 'rpc',
    cascadeId: 'c1',
    txHash: 'h1',
    detail: { step: 'repay', lines: ['Repaid 120 USDC on Burrow'] },
  }),
  ev({
    at: at(4),
    kind: 'signed',
    source: 'rpc',
    cascadeId: 'c1',
    txHash: 'h2',
    detail: { step: 'withdraw', lines: ['Withdrew 0.5 wNEAR from Burrow'] },
  }),
  ev({
    at: at(5),
    kind: 'prepare',
    cascadeId: 'c2',
    intent: { action: 'supply' },
    detail: { steps: [{}], preview: ['Supply'] },
  }),
  ev({
    at: at(6),
    kind: 'prepare_blocked',
    cascadeId: 'c3',
    intent: { action: 'swap' },
    detail: { steps: [{}] },
  }),
  ev({
    at: at(7),
    kind: 'prepare',
    cascadeId: 'c4',
    intent: { action: 'repay' },
    detail: twoSteps,
  }),
  ev({
    at: at(8),
    kind: 'signed',
    source: 'rpc',
    cascadeId: 'c4',
    txHash: 'h3',
    detail: { step: 'repay', lines: [] },
  }),
];

describe('activityTimeline', () => {
  it('the owner sees everything, newest first, one item per cascade', () => {
    const t = activityTimeline(rows, { owner: true });
    expect(t.map((i) => (i.type === 'cascade' ? `${i.cascadeId}:${i.status}` : i.type))).toEqual([
      'c4:partial',
      'c3:blocked',
      'c2:not_signed',
      'c1:confirmed',
      'analyse',
      'connect',
    ]);
    const c1 = t.find((i) => i.type === 'cascade' && i.cascadeId === 'c1');
    expect(c1).toMatchObject({
      action: 'repay',
      preview: ['Repay 120 USDC', 'Withdraw 0.5 NEAR'],
      signed: [
        { hash: 'h1', lines: ['Repaid 120 USDC on Burrow'] },
        { hash: 'h2', lines: ['Withdrew 0.5 wNEAR from Burrow'] },
      ],
    });
    expect(t.find((i) => i.type === 'analyse')).toMatchObject({ source: 'ai' });
  });

  it('a step signed twice still leaves the cascade partly signed', () => {
    const twice = [
      ev({
        at: at(0),
        kind: 'prepare',
        cascadeId: 'c9',
        intent: { action: 'repay' },
        detail: twoSteps,
      }),
      ev({ at: at(1), kind: 'signed', cascadeId: 'c9', txHash: 'x1', detail: { step: 'repay' } }),
      ev({ at: at(2), kind: 'signed', cascadeId: 'c9', txHash: 'x2', detail: { step: 'repay' } }),
    ];
    expect(activityTimeline(twice, { owner: true })[0]).toMatchObject({ status: 'partial' });
  });

  it('the public sees only confirmed transactions and their cascades', () => {
    const t = activityTimeline(rows, { owner: false });
    expect(t.map((i) => (i.type === 'cascade' ? i.cascadeId : i.type))).toEqual(['c4', 'c1']);
  });
});

describe('POST /v1/events', () => {
  const setup = () => {
    const store = new MemoryEventStore();
    let now = at(0);
    const app = Fastify();
    registerEvents(app, store, () => now);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/v1/events', payload });
    return { store, post, setNow: (d: Date) => (now = d) };
  };

  it('stores a connect as client-reported, once per account per UTC day', async () => {
    const { store, post, setNow } = setup();
    expect((await post({ kind: 'connect', account: 'alice.near' })).json()).toEqual({
      stored: true,
    });
    expect((await post({ kind: 'connect', account: 'alice.near' })).json()).toEqual({
      stored: false,
    });
    setNow(new Date(Date.UTC(2026, 10, 15, 0, 1)));
    expect((await post({ kind: 'connect', account: 'alice.near' })).json()).toEqual({
      stored: true,
    });
    expect(store.rows.map((r) => [r.kind, r.source])).toEqual([
      ['connect', 'client'],
      ['connect', 'client'],
    ]);
  });

  it('refuses any other kind or extra field with a short error', async () => {
    const { store, post } = setup();
    for (const payload of [
      { kind: 'signed', account: 'alice.near', hash: 'x' },
      { kind: 'connect', account: 'alice.near', ip: '1.2.3.4' },
      { kind: 'connect', account: 'Not An Account' },
    ]) {
      const res = await post(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid event' });
    }
    expect(store.rows).toHaveLength(0);
  });
});

describe('shortAccount', () => {
  it('never shows a name whole, however short', () => {
    expect(shortAccount('bob.near')).toBe('b…near');
    expect(shortAccount('a.near')).toBe('…near');
    expect(shortAccount('autopilot-test.near')).toBe('aut…near');
    expect(shortAccount('a'.repeat(64))).toBe('aaaaaa…aaaa');
  });
});

describe('GET /v1/analytics/policy/cascades', () => {
  it('lists stored verdicts with their checks and a shortened account', async () => {
    const store = new MemoryEventStore();
    const implicit = 'a'.repeat(64);
    await store.add({
      at: at(1),
      kind: 'prepare_blocked',
      accountId: implicit,
      source: 'server',
      cascadeId: 'c1',
      intent: { action: 'swap' },
      verdict: 'BLOCK',
      checks: [{ rule: 'receivers', pass: false, messages: ['x'] }],
    });
    const app = Fastify();
    registerEvents(app, store, () => at(2));
    const r = (await app.inject({ url: '/v1/analytics/policy/cascades' })).json<{
      verdicts: unknown[];
    }>();
    expect(r.verdicts).toEqual([
      expect.objectContaining({
        account: 'aaaaaa…aaaa',
        intent: { action: 'swap' },
        action: 'swap',
        verdict: 'BLOCK',
        checks: [{ rule: 'receivers', pass: false, messages: ['x'] }],
      }),
    ]);
  });

  it('names no account and no amount, also inside the summary and the check messages', async () => {
    const store = new MemoryEventStore();
    await store.add({
      at: at(1),
      kind: 'prepare_blocked',
      accountId: 'autopilot-test.near',
      source: 'server',
      intent: { action: 'swap', token: 'wrap.near', approxUsd: 1234, amount: '99' },
      verdict: 'BLOCK',
      checks: [
        {
          rule: 'signer',
          pass: false,
          messages: ['swap: signer autopilot-test.near is not the connected account'],
        },
      ],
      detail: {
        summary: {
          signer: 'autopilot-test.near',
          receivers: ['wrap.near'],
          methods: ['near_deposit'],
          gas: '1',
          deposit: '5000000000000000000000000',
        },
        preview: ['Wrap 5 NEAR'],
      },
    });
    const app = Fastify();
    registerEvents(app, store, () => at(2));
    const body = (await app.inject({ url: '/v1/analytics/policy/cascades' })).body;
    expect(body).not.toMatch(/autopilot-test\.near|1234|"99"|5000000000000000000000000|Wrap 5/);
    expect((JSON.parse(body) as { verdicts: unknown[] }).verdicts[0]).toMatchObject({
      account: 'aut…near',
      intent: { action: 'swap', token: 'wrap.near' },
      summary: { signer: 'aut…near', deposit: null },
      checks: [{ messages: ['swap: signer aut…near is not the connected account'] }],
    });
  });
});
