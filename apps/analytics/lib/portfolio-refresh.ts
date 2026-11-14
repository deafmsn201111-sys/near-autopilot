const ATTEMPTS = 6;
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
 * After a transaction from this wallet: reads the account fresh and re-renders every 5 s, up to 6 reads. `read` says
 * whether the holdings changed since the previous read. The first change may be only part of it (a swap's input leaves
 * at once, its output lands a few blocks later), so it stops at the first read after a change that shows nothing new,
 * or on a failed read. One refresh per account at a time; a second trigger joins it.
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
    let changed = false;
    for (let i = 0; i < ATTEMPTS; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, RETRY_MS));
      const moved = await read(account).catch(() => null);
      rerender();
      if (moved === null || (changed && !moved)) break;
      changed ||= moved;
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
