import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.fn();
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', '203.0.113.7']]),
}));
vi.mock('../lib/api', () => ({
  tryApi: async (path: string) => {
    reads(path);
    return { data: { accountId: 'alice.near', recommendations: [] }, error: null };
  },
}));

const load = () => import('../lib/product');

describe('account read cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    reads.mockClear();
  });

  it('re-renders within 30 s read the account once', async () => {
    const p = await load();
    await p.accountView('alice.near');
    await p.accountRecommendations('alice.near');
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('an open tab refreshing every 15 s never hits the rate limit', async () => {
    vi.useFakeTimers();
    const p = await load();
    for (let i = 0; i < 80; i++) {
      expect((await p.accountView('alice.near')).error).toBeNull();
      vi.advanceTimersByTime(15_000);
    }
  });

  it('reads again after 30 s', async () => {
    vi.useFakeTimers();
    const p = await load();
    await p.accountView('alice.near');
    vi.advanceTimersByTime(30_000);
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('reads again at once after the account is forgotten (a new transaction)', async () => {
    const p = await load();
    await p.accountView('alice.near');
    p.forgetAccount('alice.near');
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
