import { beforeEach, describe, expect, it, vi } from 'vitest';

let answer: { data: unknown; error: string | null; status: number | null };
let forwardedFor = '203.0.113.7';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('../lib/api', () => ({ tryApi: async () => answer }));

const good = (asOf: string) => ({
  data: {
    accountId: 'alice.near',
    asOf,
    recommendations: [],
    ownerVerified: false,
    holdings: [{ where: 'wallet', token: 'near', amount: 1 }],
  },
  error: null,
  status: null,
});
const down = { data: null, error: 'the analytics service is unreachable', status: 0 };

const load = () => import('../lib/product');

describe('a read that fails after a good one', () => {
  beforeEach(() => {
    vi.resetModules();
    forwardedFor = '203.0.113.7';
  });

  it('keeps the last good account read on screen, marked stale with its own time', async () => {
    const p = await load();
    answer = good('2026-11-14T10:00:00.000Z');
    await p.accountView('alice.near');
    answer = down;
    await p.forgetAccount('alice.near');
    const r = await p.accountView('alice.near');
    expect(r.stale).toBe(true);
    expect(r.status).toBe(0);
    expect(r.data?.asOf).toBe('2026-11-14T10:00:00.000Z');
  });

  it('has nothing to show for an account never read, and says it failed', async () => {
    const p = await load();
    answer = down;
    const r = await p.accountView('alice.near');
    expect(r.data).toBeNull();
    expect(r.stale).toBe(false);
    expect(r.status).toBe(0);
  });

  it("never shows another visitor's last read", async () => {
    const p = await load();
    answer = good('2026-11-14T10:00:00.000Z');
    await p.accountView('alice.near');
    forwardedFor = '198.51.100.9';
    answer = down;
    expect((await p.accountView('alice.near')).data).toBeNull();
  });

  it('a refresh after a transaction still reports the failure, not the old holdings', async () => {
    const p = await load();
    answer = good('2026-11-14T10:00:00.000Z');
    await p.accountView('alice.near');
    answer = down;
    expect(await p.refreshAccountRead('alice.near')).toBeNull();
  });

  it('keeps the last good demo portfolio too', async () => {
    const p = await load();
    answer = {
      data: { id: 'demo-5000', asOf: '2026-11-14T09:55:00.000Z' },
      error: null,
      status: null,
    };
    await p.portfolioView('demo-5000');
    answer = down;
    const r = await p.portfolioView('demo-5000');
    expect(r).toMatchObject({ stale: true, data: { asOf: '2026-11-14T09:55:00.000Z' } });
  });
});

describe('one render over a failed read', () => {
  beforeEach(() => vi.resetModules());

  it('asks the API once, not once per section', async () => {
    const api = await import('../lib/api');
    const spy = vi.spyOn(api, 'tryApi');
    const p = await load();
    answer = down;
    await p.accountView('carol.near');
    await p.accountRecommendations('carol.near');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
