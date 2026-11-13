'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clearOwnershipProof } from '../app/account-actions';
import { connect, disconnect, watchAccount } from '../lib/wallet';

const portfolioUrl = (id: string) => `/?p=account&account=${encodeURIComponent(id)}`;

function rememberAccount(id: string | null): boolean {
  const before = document.cookie.match(/(?:^|; )np_account=([^;]*)/)?.[1] ?? '';
  document.cookie = id
    ? `np_account=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`
    : 'np_account=; path=/; max-age=0; samesite=lax';
  return before !== (id ? encodeURIComponent(id) : '');
}

/**
 * Connect a NEAR wallet through HOT Connector to see your own portfolio. Sign-in only: no access key, no signature
 * (proving ownership for AI analysis is a separate, optional step: components/OwnershipCheck.tsx).
 * Right after a successful sign-in the page opens that account with a full page load, the same way on the first and
 * on every later connection; an already connected wallet never redirects by itself. Disconnecting returns the page
 * to its starting state (the demo portfolio, Demo mode).
 */
export function WalletButton() {
  const [account, setAccount] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'opening'>('idle');
  const router = useRouter();

  // Remember the connected account in a cookie so server pages (and the "Mainnet account" tab) can find it without the
  // id sitting in the URL — otherwise navigating away and back loses it and the portfolio reads empty.
  useEffect(
    () =>
      watchAccount((id) => {
        setAccount(id);
        if (rememberAccount(id)) router.refresh();
      }),
    [router],
  );

  if (state === 'opening') return <span className="wallet-chip muted-note">One moment…</span>;
  if (account)
    return (
      <span className="wallet-chip">
        <Link
          className="wallet-id"
          href={portfolioUrl(account)}
          title={`${account}: open my portfolio`}
        >
          {account.length > 20 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account}
        </Link>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => {
            // Back to the starting state: the demo portfolio in Demo mode, with a full page load.
            setState('opening');
            void Promise.allSettled([disconnect(), clearOwnershipProof()]).finally(() => {
              setAccount(null);
              rememberAccount(null);
              document.cookie = 'autopilot-mode=demo; path=/; max-age=31536000; samesite=lax';
              window.location.assign('/');
            });
          }}
        >
          Disconnect
        </button>
      </span>
    );
  return (
    <button
      type="button"
      className="btn primary small"
      disabled={state === 'connecting'}
      onClick={() => {
        setState('connecting');
        connect()
          .then((id) => {
            if (!id) return setState('idle');
            setAccount(id);
            rememberAccount(id);
            setState('opening');
            window.location.assign(portfolioUrl(id));
          })
          .catch(() => setState('idle')); // the list was closed or the wallet refused: stay here
      }}
    >
      {state === 'connecting' ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
