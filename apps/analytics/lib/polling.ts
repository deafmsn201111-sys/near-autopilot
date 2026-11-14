export interface PollOptions {
  /** A fixed gap, or one that depends on how many ticks ran so far (a backoff). */
  everyMs: number | ((ticks: number) => number);
  forMs: number;
  hidden: () => boolean;
}

/**
 * Calls `tick` after each gap while visible and stops after `forMs`, so an unattended tab goes quiet. A hidden turn is
 * skipped and does not count as a tick. When the tab becomes visible or gets focus, the `forMs` window starts over
 * (with an immediate tick if it had stopped). Returns a stop function.
 */
export function poll(tick: () => void, { everyMs, forMs, hidden }: PollOptions): () => void {
  const gap = typeof everyMs === 'number' ? () => everyMs : everyMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopAt = 0;
  let ticks = 0;

  const halt = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const run = () => {
    tick();
    ticks++;
  };
  const schedule = () => {
    timer = setTimeout(() => {
      if (Date.now() > stopAt) return halt();
      if (!hidden()) run();
      schedule();
    }, gap(ticks));
  };
  const start = () => {
    stopAt = Date.now() + forMs;
    if (timer === undefined) schedule();
  };
  const onPresence = () => {
    if (hidden()) return;
    const wasHalted = timer === undefined || Date.now() > stopAt;
    if (wasHalted) halt();
    start();
    if (wasHalted) run();
  };

  start();
  document.addEventListener('visibilitychange', onPresence);
  window.addEventListener('focus', onPresence);
  return () => {
    halt();
    document.removeEventListener('visibilitychange', onPresence);
    window.removeEventListener('focus', onPresence);
  };
}

export const POLL_FOR_MS = 30 * 60_000;
export const tabHidden = () => document.visibilityState === 'hidden';
