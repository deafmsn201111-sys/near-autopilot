import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshUntilChecked } from '../lib/ownership-refresh';

describe('refreshUntilChecked', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-renders at once and again on every gap until stopped', () => {
    const refresh = vi.fn();
    const giveUp = vi.fn();
    const stop = refreshUntilChecked(refresh, giveUp, { everyMs: 2_000, forMs: 20_000 });
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(giveUp).not.toHaveBeenCalled();
  });

  it('gives up once after its time and stops re-rendering', () => {
    const refresh = vi.fn();
    const giveUp = vi.fn();
    refreshUntilChecked(refresh, giveUp, { everyMs: 2_000, forMs: 6_000 });
    vi.advanceTimersByTime(6_000);
    expect(giveUp).toHaveBeenCalledTimes(1);
    const calls = refresh.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(calls);
    expect(giveUp).toHaveBeenCalledTimes(1);
  });
});
