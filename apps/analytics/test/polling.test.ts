import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../lib/polling';

describe('poll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks on the interval, skips while hidden and stops for good after its time', () => {
    let hidden = false;
    const tick = vi.fn();
    poll(tick, { everyMs: 1_000, forMs: 5_000, hidden: () => hidden });
    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);
    hidden = true;
    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);
    hidden = false;
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('stops when the returned function is called', () => {
    const tick = vi.fn();
    const stop = poll(tick, { everyMs: 1_000, forMs: 60_000, hidden: () => false });
    stop();
    vi.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
