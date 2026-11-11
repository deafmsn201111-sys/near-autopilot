import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.fn();
let forwardedFor = '203.0.113.7';
let ownerCookie: string | undefined;
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
  cookies: async () => ({
    get: (name: string) =>
      name === 'np_owner' && ownerCookie ? { value: ownerCookie } : undefined,
  }),
}));
vi.mock('../lib/api', () => ({
  tryApi: async (path: string, headers?: Record<string, string>) => {
    reads(path, headers);
    return { data: { accountId: 'alice.near', recommendations: [] }, error: null };
  },
}));

const load = () => import('../lib/product');

describe('account read cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    reads.mockClear();
    forwardedFor = '203.0.113.7';
    ownerCookie = undefined;
  });

  it('forwards the ownership proof and reads again once it is signed', async () => {
    const p = await load();
    await p.accountView('alice.near');
    ownerCookie = 'eyJwcm9vZiI6MX0';
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenLastCalledWith('/v1/analytics/account/alice.near', {
      'x-ownership-proof': 'eyJwcm9vZiI6MX0',
    });
  });

  it('re-renders within 60 s read the account once', async () => {
    const p = await load();
    await p.accountView('alice.near');
    await p.accountRecommendations('alice.near');
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('concurrent renders share one read', async () => {
    const p = await load();
    await Promise.all([p.accountView('alice.near'), p.accountRecommendations('alice.near')]);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('two accounts refreshing every 15 s stay within the limit', async () => {
    vi.useFakeTimers();
    const p = await load();
    for (let i = 0; i < 80; i++) {
      expect((await p.accountView('alice.near')).error).toBeNull();
      expect((await p.accountView('bob.near')).error).toBeNull();
      vi.advanceTimersByTime(15_000);
    }
  });

  it('an open tab refreshing every 15 s never hits the rate limit', async () => {
    vi.useFakeTimers();
    const p = await load();
    for (let i = 0; i < 80; i++) {
      expect((await p.accountView('alice.near')).error).toBeNull();
      vi.advanceTimersByTime(15_000);
    }
  });

  it('reads again after 60 s', async () => {
    vi.useFakeTimers();
    const p = await load();
    await p.accountView('alice.near');
    vi.advanceTimersByTime(60_000);
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('reads again at once after the account is forgotten (a new transaction)', async () => {
    const p = await load();
    await p.accountView('alice.near');
    await p.forgetAccount(' Alice.near ');
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("another visitor cannot drop this visitor's cached read", async () => {
    const p = await load();
    await p.accountView('alice.near');
    forwardedFor = '198.51.100.9';
    await p.forgetAccount('alice.near');
    forwardedFor = '203.0.113.7';
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
