'use client';
import '@near-wallet-selector/modal-ui/styles.css';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { connect, disconnect, watchAccount } from '../lib/wallet';

/** Connect a NEAR wallet (HOT, Meteor, Intear, MyNearWallet) to see your own portfolio. Sign-in only. */
export function WalletButton() {
  const router = useRouter();
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let previous: string | null = null;
    void watchAccount((id) => {
      setAccount(id);
      if (id && id !== previous) router.push(`/?p=account&account=${encodeURIComponent(id)}`);
      previous = id;
    }).then((s) => {
      stop = s;
    });
    return () => stop?.();
  }, [router]);
  return account ? (
    <span className="wallet-chip">
      <span className="wallet-id" title={account}>
        {account.length > 20 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account}
      </span>
      <button type="button" className="btn secondary small" onClick={() => void disconnect()}>
        Disconnect
      </button>
    </span>
  ) : (
    <button type="button" className="btn primary small" onClick={() => void connect()}>
      Connect wallet
    </button>
  );
}
