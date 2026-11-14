'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { saveOwnershipProof } from '../app/account-actions';
import { refreshUntilChecked } from '../lib/ownership-refresh';
import { watchAccount } from '../lib/wallet';
import { signOwnership } from '../lib/wallet-sign';

const RETRY_MS = 2000;
const CHECK_FOR_MS = 20_000;

/**
 * Which analysis this account gets. AI analysis needs proof of ownership: a NEP-413 message signed by a full-access
 * key of the account, checked on the server. Typing someone else's account, or declining to sign, gives the
 * heuristic analysis.
 */
export function OwnershipCheck({
  account,
  verified,
  checkFailed,
}: {
  account: string;
  verified: boolean;
  checkFailed: boolean;
}) {
  const router = useRouter();
  const [connected, setConnected] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'signing' | 'checking' | 'declined' | 'rejected'>(
    'idle',
  );
  const [checking, startChecking] = useTransition();
  useEffect(() => watchAccount(setConnected), []);
  const waitingForProof = state === 'checking' && !verified && !checkFailed;
  useEffect(() => {
    if (!waitingForProof) return;
    return refreshUntilChecked(
      () => router.refresh(),
      () => setState('rejected'),
      { everyMs: RETRY_MS, forMs: CHECK_FOR_MS },
    );
  }, [waitingForProof, router]);
  useEffect(() => {
    if (!checkFailed) return;
    const retry = setTimeout(() => router.refresh(), RETRY_MS);
    return () => clearTimeout(retry);
  }, [checkFailed, router]);

  if (verified)
    return (
      <div className="callout" style={{ margin: '16px 0' }}>
        <b>Ownership verified.</b> You signed the ownership message for {account}, so this account
        can get AI analysis.
      </div>
    );

  if (checkFailed)
    return (
      <div className="callout" style={{ margin: '16px 0' }}>
        <b>Heuristic analysis for now.</b> We couldn&apos;t check your signature: the network did
        not answer in time. You don&apos;t need to sign again.{' '}
        <button
          type="button"
          className="btn secondary small"
          disabled={checking}
          onClick={() => startChecking(() => router.refresh())}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    );

  const isOwnerWallet = connected === account;
  return (
    <div className="callout" style={{ margin: '16px 0' }}>
      <b>Heuristic analysis.</b>{' '}
      {isOwnerWallet ? (
        <>
          Sign a short message in your wallet to prove you own {account} and unlock AI analysis. It
          is not a transaction: nothing is sent and no gas is paid.{' '}
          <button
            type="button"
            className="btn primary small"
            disabled={state === 'signing' || state === 'checking'}
            onClick={() => {
              setState('signing');
              void signOwnership(account).then(async (proof) => {
                if (!proof) return setState('declined');
                try {
                  await saveOwnershipProof(proof);
                  setState('checking');
                } catch {
                  setState('declined');
                }
              });
            }}
          >
            {state === 'checking'
              ? 'Checking your signature…'
              : state === 'signing'
                ? 'Waiting for the wallet…'
                : 'Verify ownership'}
          </button>
          {state === 'declined' && (
            <span className="muted-note"> Not signed: you keep the heuristic analysis.</span>
          )}
          {state === 'rejected' && (
            <span className="muted-note">
              {' '}
              The signature was not accepted: you keep the heuristic analysis.
            </span>
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
