'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { connect, disconnect, watchAccount } from '../lib/wallet';

const portfolioUrl = (id: string) => `/?p=account&account=${encodeURIComponent(id)}`;

/**
 * Connect a NEAR wallet through HOT Connector to see your own portfolio. Sign-in only: no access key, no signature.
 * Right after a successful sign-in the page opens that account with a full page load, the same way on the first and
 * on every later connection; an already connected wallet never redirects by itself.
 */
export function WalletButton() {
  const [account, setAccount] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'opening'>('idle');

  useEffect(() => watchAccount(setAccount), []);

  if (state === 'opening')
    return <span className="wallet-chip muted-note">Opening your portfolio…</span>;
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
            void disconnect().finally(() => setAccount(null));
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
