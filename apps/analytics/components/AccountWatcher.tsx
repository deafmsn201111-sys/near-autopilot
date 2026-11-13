'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { refreshAccount } from '../app/account-actions';
import { poll, POLL_FOR_MS, tabHidden } from '../lib/polling';
import { refreshing, refreshPortfolio, subscribe } from '../lib/portfolio-refresh';

/**
 * The on-chain watcher: for the connected account it polls the access-key nonces on NEAR mainnet and, the moment a new
 * transaction from this wallet lands (any nonce goes up), re-reads the real portfolio past every cache and re-renders
 * the page (router.refresh, no reload), retrying for a few seconds until the new state shows. It watches while the tab
 * is visible and for 30 minutes after the user last came back to it, and says so on the page while it updates.
 */
const RPC = 'https://rpc.mainnet.fastnear.com';

async function maxNonce(account: string): Promise<bigint | null> {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'w',
        method: 'query',
        params: {
          request_type: 'view_access_key_list',
          finality: 'optimistic',
          account_id: account,
        },
      }),
    });
    const json = (await res.json()) as {
      result?: { keys?: { access_key?: { nonce?: number | string } }[] };
    };
    const keys = json.result?.keys ?? [];
    let max = 0n;
    for (const k of keys) {
      const n = k.access_key?.nonce;
      if (n !== undefined) {
        const v = BigInt(n);
        if (v > max) max = v;
      }
    }
    return max;
  } catch {
    return null; // network hiccup: skip this tick, try again
  }
}

export function AccountWatcher({ account, seconds = 6 }: { account: string; seconds?: number }) {
  const router = useRouter();
  const last = useRef<bigint | null>(null);
  const updating = useSyncExternalStore(
    subscribe,
    () => refreshing(account),
    () => false,
  );

  useEffect(() => {
    let alive = true;
    last.current = null;
    void maxNonce(account).then((n) => {
      if (alive) last.current = n;
    });
    const stop = poll(
      () =>
        void maxNonce(account).then((n) => {
          if (!alive || n === null) return;
          if (last.current !== null && n > last.current)
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
