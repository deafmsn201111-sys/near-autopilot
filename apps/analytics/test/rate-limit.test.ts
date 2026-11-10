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
