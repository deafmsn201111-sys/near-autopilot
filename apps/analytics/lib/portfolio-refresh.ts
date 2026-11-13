const ATTEMPTS = 4;
const RETRY_MS = 5_000;

const running = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const keyOf = (account: string) => account.trim().toLowerCase();

export const refreshing = (account: string) => running.has(keyOf(account));

export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/**
 * After a transaction from this wallet: reads the account fresh and re-renders, retrying every 5 s (the chain may
 * still show the old state at first) until `read` says the new state arrived, or after 4 reads. One refresh per
 * account at a time; a second trigger joins it.
 */
export function refreshPortfolio(
  account: string,
  read: (account: string) => Promise<boolean>,
  rerender: () => void,
): Promise<void> {
  const key = keyOf(account);
  const current = running.get(key);
  if (current) return current;
  const run = (async () => {
    for (let i = 0; i < ATTEMPTS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
      const settled = await read(account).catch(() => true);
      rerender();
      if (settled) break;
    }
  })().finally(() => {
    running.delete(key);
    notify();
  });
  running.set(key, run);
  notify();
  return run;
}
