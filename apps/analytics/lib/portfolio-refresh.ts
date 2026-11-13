const ATTEMPTS = 4;
const RETRY_MS = 5_000;

const QUIET_AFTER_MS = 10_000;

const running = new Map<string, Promise<void>>();
const endedAt = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

const keyOf = (account: string) => account.trim().toLowerCase();

export const refreshing = (account: string) => running.has(keyOf(account));

/** True while a refresh runs and for 10 s after it ends, so a watcher tick that lags the chain does not start another. */
export const recentlyRefreshed = (account: string, now = Date.now()) =>
  refreshing(account) || now - (endedAt.get(keyOf(account)) ?? -Infinity) < QUIET_AFTER_MS;

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
    endedAt.set(key, Date.now());
    notify();
  });
  running.set(key, run);
  notify();
  return run;
}
