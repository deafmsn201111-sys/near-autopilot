import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guard reads the visitor's address from the request headers; here each test sets it.
let forwardedFor = '203.0.113.1';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
}));

describe('account lookup rate limit', () => {
  beforeEach(() => {
    vi.resetModules();
    forwardedFor = '203.0.113.1';
  });

  it('is always on, and one visitor over the limit does not block another', async () => {
    const { consume, ACCOUNT_LIMIT } = await import('../lib/rate-limit');
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) expect(await consume('account', ACCOUNT_LIMIT, now)).toBe(true);
    expect(await consume('account', ACCOUNT_LIMIT, now)).toBe(false);
    forwardedFor = '198.51.100.7';
    expect(await consume('account', ACCOUNT_LIMIT, now)).toBe(true);
    forwardedFor = '203.0.113.1';
    expect(await consume('account', ACCOUNT_LIMIT, now + 10 * 60_000 + 1)).toBe(true);
  });
});

describe('rate limiter memory', () => {
  beforeEach(() => vi.resetModules());

  it('stays bounded under a flood of new visitors and keeps the overall cap', async () => {
    const { consume, trackedKeys, MAX_TRACKED_KEYS } = await import('../lib/rate-limit');
    const limit = { perVisitor: 1, overall: 5, windowMs: 60_000 };
    const now = 1_000_000;
    for (let i = 0; i < MAX_TRACKED_KEYS + 100; i++) {
      forwardedFor = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      await consume('flood', limit, now);
    }
    expect(trackedKeys()).toBeLessThanOrEqual(MAX_TRACKED_KEYS);
    forwardedFor = '192.0.2.1';
    expect(await consume('flood', limit, now)).toBe(false);
  });
});
