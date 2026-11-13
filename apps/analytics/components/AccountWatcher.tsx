'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { refreshAccount } from '../app/account-actions';
import { readAccountSignal } from '../lib/account-signal';
import { poll, POLL_FOR_MS, tabHidden } from '../lib/polling';
import { refreshing, refreshPortfolio, subscribe } from '../lib/portfolio-refresh';

/**
 * The on-chain watcher: for the connected account it polls NEAR mainnet and, the moment something lands on it (a new
 * transaction from this wallet or an incoming NEAR transfer), re-reads the real portfolio past every cache and
 * re-renders the page (router.refresh, no reload), retrying for a few seconds until the new state shows. It watches
 * while the tab is visible and for 30 minutes after the user last came back to it, and says so on the page while it
 * updates.
 */
export function AccountWatcher({ account, seconds = 6 }: { account: string; seconds?: number }) {
  const router = useRouter();
  const last = useRef<string | null>(null);
  const updating = useSyncExternalStore(
    subscribe,
    () => refreshing(account),
    () => false,
  );

  useEffect(() => {
    let alive = true;
    last.current = null;
    void readAccountSignal(account).then((n) => {
      if (alive) last.current = n;
    });
    const stop = poll(
      () =>
        void readAccountSignal(account).then((n) => {
          if (!alive || n === null) return;
          if (last.current !== null && n !== last.current)
            void refreshPortfolio(account, refreshAccount, () => router.refresh());
          last.current = n;
        }),
      { everyMs: seconds * 1000, forMs: POLL_FOR_MS, hidden: tabHidden },
    );
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
