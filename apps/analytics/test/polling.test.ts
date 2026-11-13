import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poll } from '../lib/polling';

describe('poll', () => {
  let win: EventTarget;
  let doc: EventTarget & { visibilityState: string };

  beforeEach(() => {
    vi.useFakeTimers();
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ticks on the interval, skips while hidden and stops after its time', () => {
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

  it('restarts with a fresh window when the tab becomes visible again', () => {
    const tick = vi.fn();
    poll(tick, { everyMs: 1_000, forMs: 5_000, hidden: () => doc.visibilityState === 'hidden' });
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(5);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledTimes(5);

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(10);
  });

  it('restarts on window focus', () => {
    const tick = vi.fn();
    poll(tick, { everyMs: 1_000, forMs: 5_000, hidden: () => false });
    vi.advanceTimersByTime(10_000);
    win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(10);
  });

  it('extends the window on presence while still running, without doubling ticks', () => {
    const tick = vi.fn();
    poll(tick, { everyMs: 1_000, forMs: 5_000, hidden: () => false });
    vi.advanceTimersByTime(4_000);
    win.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(9);
  });

  it('stops when the returned function is called and ignores presence afterwards', () => {
    const tick = vi.fn();
    const stop = poll(tick, { everyMs: 1_000, forMs: 60_000, hidden: () => false });
    stop();
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5_000);
    expect(tick).not.toHaveBeenCalled();
  });
});
