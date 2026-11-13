'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { refreshAccount } from '../app/account-actions';
import { readAccount, watchStep, type WatchState } from '../lib/account-signal';
import { poll, POLL_FOR_MS, tabHidden } from '../lib/polling';
import { refreshing, refreshPortfolio, subscribe } from '../lib/portfolio-refresh';

/**
 * The on-chain watcher: for the connected account it polls NEAR mainnet and, the moment something lands on it (its native
 * balance moves: an incoming NEAR transfer or a transaction from this wallet), re-reads the real portfolio past every cache and
 * re-renders the page (router.refresh, no reload), retrying for a few seconds until the new state shows. It watches
 * while the tab is visible and for 30 minutes after the user last came back to it, and says so on the page while it
 * updates.
 */
export function AccountWatcher({ account, seconds = 6 }: { account: string; seconds?: number }) {
  const router = useRouter();
  const updating = useSyncExternalStore(
    subscribe,
    () => refreshing(account),
    () => false,
  );

  useEffect(() => {
    let alive = true;
    let state: WatchState = { last: null, firedAt: -Infinity };
    const tick = () =>
      void readAccount(account).then((reading) => {
        if (!alive) return;
        const step = watchStep(state, reading, Date.now());
        state = step.state;
        if (step.fire) void refreshPortfolio(account, refreshAccount, () => router.refresh());
      });
    tick();
    const stop = poll(tick, { everyMs: seconds * 1000, forMs: POLL_FOR_MS, hidden: tabHidden });
    return () => {
      alive = false;
      stop();
    };
  }, [account, seconds, router]);

  return updating ? (
    <div className="callout" role="status" style={{ marginBottom: 12 }}>
      Transaction seen, updating your portfolio…
    </div>
  ) : null;
}
