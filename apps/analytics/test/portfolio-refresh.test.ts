import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshing, refreshPortfolio, subscribe } from '../lib/portfolio-refresh';

describe('refreshPortfolio', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries every 5 s while the account looks unchanged, then stops after 4 reads', async () => {
    const read = vi.fn(async () => false);
    const rerender = vi.fn();
    const done = refreshPortfolio('alice.near', read, rerender);
    expect(refreshing('alice.near')).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(read).toHaveBeenCalledTimes(4);
    expect(rerender).toHaveBeenCalledTimes(4);
    expect(refreshing('alice.near')).toBe(false);
  });

  it('stops as soon as the new state arrives', async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const done = refreshPortfolio('alice.near', read, () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a second trigger joins the running refresh and listeners hear start and end', async () => {
    const read = vi.fn(async () => true);
    const heard = vi.fn();
    const off = subscribe(heard);
    const a = refreshPortfolio('alice.near', read, () => undefined);
    const b = refreshPortfolio('alice.near', read, () => undefined);
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
});
