import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.fn();
let forwardedFor = '203.0.113.7';
let ownerCookie: string | undefined;
let nearInWallet = 1;
let supplied = 100;
let ownerCheckFailed: boolean | undefined;
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
    return {
      data: {
        accountId: 'alice.near',
        recommendations: [],
        ownerVerified: false,
        ...(ownerCheckFailed && { ownerCheckFailed }),
        holdings: [
          { where: 'wallet', token: 'near', amount: nearInWallet },
          { where: 'deposited', token: 'usdt', amount: supplied },
        ],
      },
      error: null,
    };
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
    nearInWallet = 1;
    supplied = 100;
    ownerCheckFailed = undefined;
  });

  it('interest and gas dust are not a new state; the cached read expiring does not lose the baseline', async () => {
    vi.useFakeTimers();
    const p = await load();
    await p.accountView('alice.near');
    vi.advanceTimersByTime(120_000);
    await p.accountView('bob.near');
    supplied = 100.000001;
    nearInWallet = 0.99997;
    expect(await p.refreshAccountRead('alice.near')).toBe(false);
    supplied = 150;
    expect(await p.refreshAccountRead('alice.near')).toBe(true);
  });

  it('forwards the ownership proof and reads again once it is signed', async () => {
    const p = await load();
    await p.accountView('alice.near');
    ownerCookie = 'eyJwcm9vZiI6MX0';
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
    expect(reads).toHaveBeenLastCalledWith('/v1/analytics/account/alice.near?strategy=balanced', {
      'x-ownership-proof': 'eyJwcm9vZiI6MX0',
    });
  });

  it('an ownership check that could not run is read again a second later; a plain "not the owner" is cached', async () => {
    vi.useFakeTimers();
    const p = await load();
    ownerCookie = 'eyJwcm9vZiI6MX0';
    ownerCheckFailed = true;
    await p.accountView('alice.near');
    await p.accountRecommendations('alice.near');
    expect(reads).toHaveBeenCalledTimes(1);
    ownerCheckFailed = undefined;
    vi.advanceTimersByTime(1_000);
    await p.accountView('alice.near');
    vi.advanceTimersByTime(30_000);
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('keys the read by strategy and asks the API for that strategy', async () => {
    const p = await load();
    await p.accountView('alice.near', 'aggressive');
    await p.accountRecommendations('alice.near', 'aggressive');
    await p.accountView('alice.near', 'conservative');
    expect(reads.mock.calls.map(([path]) => String(path))).toEqual([
      '/v1/analytics/account/alice.near?strategy=aggressive',
      '/v1/analytics/account/alice.near?strategy=conservative',
    ]);
  });

  it('a refresh forgets the read under every strategy', async () => {
    const p = await load();
    await p.accountView('alice.near', 'aggressive');
    await p.forgetAccount('alice.near');
    await p.accountView('alice.near', 'aggressive');
    expect(reads).toHaveBeenCalledTimes(2);
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

  it('a refresh after a transaction reads past the API cache and says whether the account changed', async () => {
    const p = await load();
    await p.accountView('alice.near');
    expect(await p.refreshAccountRead(' Alice.near ')).toBe(false);
    expect(reads).toHaveBeenLastCalledWith(
      '/v1/analytics/account/alice.near?strategy=balanced&fresh=1',
      {},
    );
    nearInWallet = 0.9;
    expect(await p.refreshAccountRead('alice.near')).toBe(true);
    await p.accountView('alice.near');
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it('Next runs server actions on a separate copy of the module: a refresh there is what the page reads', async () => {
    const page = await load();
    await page.accountView('alice.near');
    vi.resetModules();
    const action = await load();
    expect(await action.refreshAccountRead('alice.near')).toBe(false);
    nearInWallet = 0.5;
    expect(await action.refreshAccountRead('alice.near')).toBe(true);
    expect((await page.accountView('alice.near')).data?.holdings[0]?.amount).toBe(0.5);
    for (let i = 0; i < 27; i++) await action.refreshAccountRead('alice.near');
    expect((await page.accountView('bob.near')).error).not.toBeNull();
  });

  it('a refresh counts toward the visitor limit and stops once it is spent', async () => {
    const p = await load();
    for (let i = 0; i < 30; i++) await p.refreshAccountRead('alice.near');
    expect(reads).toHaveBeenCalledTimes(30);
    expect(await p.refreshAccountRead('alice.near')).toBe(null);
    expect(reads).toHaveBeenCalledTimes(30);
  });

  it("another visitor cannot drop this visitor's cached read", async () => {
    const p = await load();
    await p.accountView('alice.near');
    forwardedFor = '198.51.100.9';
    await p.refreshAccountRead('alice.near');
    forwardedFor = '203.0.113.7';
    await p.accountView('alice.near');
    expect(reads.mock.calls.filter(([path]) => !String(path).includes('fresh'))).toHaveLength(1);
  });
});
