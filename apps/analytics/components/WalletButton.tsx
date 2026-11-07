'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { connect, disconnect, watchAccount } from '../lib/wallet';

/**
 * Connect a NEAR wallet through HOT Connector to see your own portfolio. Sign-in only: no access key, no signature.
 * Right after a sign-in started here the page opens that account; an already connected wallet never redirects.
 */
export function WalletButton() {
  const router = useRouter();
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signingIn = useRef(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void watchAccount((id) => {
      setAccount(id);
      if (id && signingIn.current) {
        signingIn.current = false;
        router.push(`/?p=account&account=${encodeURIComponent(id)}`);
      }
    }).then((s) => {
      stop = s;
    });
    return () => stop?.();
  }, [router]);

  if (account)
    return (
      <span className="wallet-chip">
        <Link
          className="wallet-id"
          href={`/?p=account&account=${encodeURIComponent(account)}`}
          title={`${account}: open my portfolio`}
        >
          {account.length > 20 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account}
        </Link>
        <button type="button" className="btn secondary small" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </span>
    );
  return (
    <button
      type="button"
      className="btn primary small"
      disabled={busy}
      onClick={() => {
        signingIn.current = true;
        setBusy(true);
        void connect()
          .catch(() => {
            signingIn.current = false; // closed or failed: stay where we are
          })
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
