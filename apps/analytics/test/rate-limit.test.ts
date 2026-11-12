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

describe('visitor key', () => {
  beforeEach(() => vi.resetModules());

  it.each([
    ['203.0.113.1', '203.0.113.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['64:ff9b::198.51.100.7', '64:ff9b:0:0::/64'],
    ['0:0:0:0:0:ffff:203.0.113.1', '203.0.113.1'],
    ['::ffff:cb00:7101', '203.0.113.1'],
    ['203.0.113.1:5555', '203.0.113.1:5555'],
    ['1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8:9'],
    ['zzzz::1', 'zzzz::1'],
    ['1::2::3', '1::2::3'],
  ])('keys %s as %s', async (address, key) => {
    forwardedFor = address;
    const { visitor } = await import('../lib/rate-limit');
    expect(await visitor()).toBe(key);
  });

  it('gives one IPv6 /64 a single per-visitor limit', async () => {
    const { consume, ACCOUNT_LIMIT } = await import('../lib/rate-limit');
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) {
      forwardedFor = `2001:db8:1:2::${i.toString(16)}`;
      expect(await consume('account', ACCOUNT_LIMIT, now)).toBe(true);
    }
    forwardedFor = '2001:db8:1:2:abcd::1';
    expect(await consume('account', ACCOUNT_LIMIT, now)).toBe(false);
    forwardedFor = '2001:db8:1:3::1';
    expect(await consume('account', ACCOUNT_LIMIT, now)).toBe(true);
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

describe('overall cap', () => {
  beforeEach(() => vi.resetModules());

  it('is not reset by a flood of new visitors on another kind', async () => {
    const { consume, MAX_TRACKED_KEYS } = await import('../lib/rate-limit');
    const limit = { perVisitor: 100, overall: 1, windowMs: 60_000 };
    const now = 1_000_000;
    forwardedFor = '192.0.2.1';
    expect(await consume('prepare', limit, now)).toBe(true);
    for (let i = 0; i < MAX_TRACKED_KEYS + 1; i++) {
      forwardedFor = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      await consume('account', limit, now);
    }
    forwardedFor = '192.0.2.2';
    expect(await consume('prepare', limit, now)).toBe(false);
  });
});

describe('limiter kinds with different windows', () => {
  beforeEach(() => vi.resetModules());

  const fill = async (
    consume: (
      kind: string,
      l: { perVisitor: number; overall: number; windowMs: number },
      now: number,
    ) => Promise<boolean>,
    count: number,
    now: number,
  ) => {
    const short = { perVisitor: 1, overall: 1_000_000, windowMs: 60_000 };
    for (let i = 0; i < count; i++) {
      forwardedFor = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      await consume('short', short, now);
    }
  };

  it('never drops an entry of one kind by another kind window', async () => {
    const { consume, MAX_TRACKED_KEYS } = await import('../lib/rate-limit');
    const long = { perVisitor: 1, overall: 1_000_000, windowMs: 10 * 60_000 };
    const now = 1_000_000;
    await fill(consume, MAX_TRACKED_KEYS - 1, now);
    forwardedFor = '192.0.2.1';
    expect(await consume('long', long, now)).toBe(true);
    forwardedFor = '192.0.2.2';
    await consume(
      'short',
      { perVisitor: 1, overall: 1_000_000, windowMs: 60_000 },
      now + 2 * 60_000,
    );
    forwardedFor = '192.0.2.1';
    expect(await consume('long', long, now + 2 * 60_000)).toBe(false);
  });

  it('does not scan the whole map on each call when it is full', async () => {
    const { consume, MAX_TRACKED_KEYS } = await import('../lib/rate-limit');
    const now = 1_000_000;
    await fill(consume, MAX_TRACKED_KEYS, now);
    const scans = vi.spyOn(Map.prototype, Symbol.iterator);
    forwardedFor = '192.0.2.1';
    await consume('short', { perVisitor: 1, overall: 1_000_000, windowMs: 60_000 }, now);
    expect(scans).not.toHaveBeenCalled();
    scans.mockRestore();
  });
});
