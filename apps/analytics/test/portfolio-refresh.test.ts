import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recentlyRefreshed,
  refreshing,
  refreshPortfolio,
  subscribe,
} from '../lib/portfolio-refresh';

describe('refreshPortfolio', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries every 5 s while the account looks unchanged, then stops after 6 reads', async () => {
    const read = vi.fn(async () => false);
    const rerender = vi.fn();
    const done = refreshPortfolio('alice.near', read, rerender);
    expect(refreshing('alice.near')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(read).toHaveBeenCalledTimes(6);
    expect(rerender).toHaveBeenCalledTimes(6);
    expect(refreshing('alice.near')).toBe(false);
  });

  it('after the first change keeps reading until a read shows nothing new', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const rerender = vi.fn();
    const done = refreshPortfolio('alice.near', read, rerender);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(read).toHaveBeenCalledTimes(4);
    expect(rerender).toHaveBeenCalledTimes(4);
  });

  it('a read that shows only the debit is not the end: the credit read after it is shown too', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const done = refreshPortfolio('alice.near', read, () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('a second trigger joins the running refresh and listeners hear start and end', async () => {
    const read = vi.fn(async () => {
      throw new Error('offline');
    });
    const heard = vi.fn();
    const off = subscribe(heard);
    const a = refreshPortfolio('alice.near', read, () => undefined);
    const b = refreshPortfolio(' Alice.near', read, () => undefined);
    expect(b).toBe(a);
    await a;
    off();
    expect(read).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('a failed read ends the refresh', async () => {
    const read = vi.fn(async () => {
      throw new Error('offline');
    });
    await refreshPortfolio('alice.near', read, () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(refreshing('alice.near')).toBe(false);
  });

  it('counts as recent while running and for 10 s after it ends', async () => {
    const done = refreshPortfolio(
      'carol.near',
      async () => {
        throw new Error('offline');
      },
      () => undefined,
    );
    expect(recentlyRefreshed('carol.near')).toBe(true);
    await done;
    expect(recentlyRefreshed('Carol.near')).toBe(true);
    expect(recentlyRefreshed('carol.near', Date.now() + 10_000)).toBe(false);
    expect(recentlyRefreshed('dave.near')).toBe(false);
  });
});
