'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { OWNERSHIP_COOKIE } from '@near-autopilot/core/ownership';
import { watchAccount } from '../lib/wallet';
import { signOwnership } from '../lib/wallet-sign';

/**
 * Which analysis this account gets. AI analysis needs proof of ownership: a NEP-413 message signed by a full-access
 * key of the account, checked on the server. Typing someone else's account, or declining to sign, gives the
 * heuristic analysis.
 */
export function OwnershipCheck({ account, verified }: { account: string; verified: boolean }) {
  const router = useRouter();
  const [connected, setConnected] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'signing' | 'declined'>('idle');
  useEffect(() => watchAccount(setConnected), []);

  if (verified)
    return (
      <div className="callout" style={{ marginBottom: 16 }}>
        <b>Ownership verified.</b> You signed the ownership message for {account}: AI analysis is
        unlocked for this account.
      </div>
    );

  const isOwnerWallet = connected === account;
  return (
    <div className="callout" style={{ marginBottom: 16 }}>
      <b>Heuristic analysis.</b>{' '}
      {isOwnerWallet ? (
        <>
          Sign a short message in your wallet to prove you own {account} and unlock AI analysis. It
          is not a transaction: nothing is sent and no gas is paid.{' '}
          <button
            type="button"
            className="btn primary small"
            disabled={state === 'signing'}
            onClick={() => {
              setState('signing');
              void signOwnership(account).then((proof) => {
                if (!proof) return setState('declined');
                document.cookie = `${OWNERSHIP_COOKIE}=${proof}; path=/; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
                setState('idle');
                router.refresh();
              });
            }}
          >
            {state === 'signing' ? 'Waiting for the wallet…' : 'Verify ownership'}
          </button>
          {state === 'declined' && (
            <span className="muted-note"> Not signed: you keep the heuristic analysis.</span>
          )}
        </>
      ) : (
        <>
          AI analysis is only for the account&apos;s owner. Connect the wallet of {account} and sign
          the ownership message to unlock it.
        </>
      )}
    </div>
  );
}
