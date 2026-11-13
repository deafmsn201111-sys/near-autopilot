export interface PollOptions {
  everyMs: number;
  forMs: number;
  hidden: () => boolean;
}

/**
 * Calls `tick` every `everyMs` while visible and stops after `forMs`, so an unattended tab goes quiet.
 * When the tab becomes visible or gets focus, the `forMs` window starts over (with an immediate tick if it had
 * stopped). Returns a stop function.
 */
export function poll(tick: () => void, { everyMs, forMs, hidden }: PollOptions): () => void {
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const halt = () => {
    clearInterval(interval);
    clearTimeout(deadline);
    interval = undefined;
  };
  const start = () => {
    interval ??= setInterval(() => {
      if (!hidden()) tick();
    }, everyMs);
    clearTimeout(deadline);
    deadline = setTimeout(halt, forMs);
  };
  const onPresence = () => {
    if (hidden()) return;
    const wasHalted = interval === undefined;
    start();
    if (wasHalted) tick();
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
