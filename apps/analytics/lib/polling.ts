export interface PollOptions {
  everyMs: number;
  forMs: number;
  hidden: () => boolean;
}

/** Calls `tick` every `everyMs` while visible, and stops for good after `forMs`. Returns a stop function. */
export function poll(tick: () => void, { everyMs, forMs, hidden }: PollOptions): () => void {
  const id = setInterval(() => {
    if (!hidden()) tick();
  }, everyMs);
  const deadline = setTimeout(() => clearInterval(id), forMs);
  return () => {
    clearInterval(id);
    clearTimeout(deadline);
  };
}

export const POLL_FOR_MS = 30 * 60_000;
export const tabHidden = () => document.visibilityState === 'hidden';
