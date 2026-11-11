'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { refreshAccount } from '../app/account-actions';
import { poll, POLL_FOR_MS, tabHidden } from '../lib/polling';

/**
 * The on-chain watcher: for the connected account it polls the access-key nonces on NEAR mainnet and, the moment a new
 * transaction from this wallet lands (any nonce goes up), SILENTLY re-renders the page from fresh data (router.refresh,
 * no reload). That re-reads the real portfolio and re-forms the agents' recommendations, while the tab is visible and for at most 30 minutes — so after the user signs an
 * action (or moves funds elsewhere) the portfolio, allocation and suggestions update on their own, quietly.
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
            void refreshAccount(account)
              .catch(() => undefined)
              .then(() => router.refresh());
          last.current = n;
        }),
      { everyMs: seconds * 1000, forMs: POLL_FOR_MS, hidden: tabHidden },
    );
    return () => {
      alive = false;
      stop();
    };
  }, [account, seconds, router]);

  return null;
}
