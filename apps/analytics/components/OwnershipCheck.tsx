'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition, type ReactNode } from 'react';
import { saveOwnershipProof } from '../app/account-actions';
import { refreshUntilChecked } from '../lib/ownership-refresh';
import { watchAccount } from '../lib/wallet';
import { signOwnership } from '../lib/wallet-sign';
import { Icon } from './icons';
import { Button } from './primitives';

const RETRY_MS = 2000;
const CHECK_FOR_MS = 12_000;

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
  const [state, setState] = useState<'idle' | 'signing' | 'checking' | 'declined' | 'unverified'>(
    'idle',
  );
  const [checking, startChecking] = useTransition();
  useEffect(() => watchAccount(setConnected), []);
  const waitingForProof = state === 'checking' && !verified && !checkFailed;
  useEffect(() => {
    if (!waitingForProof) return;
    return refreshUntilChecked(
      () => router.refresh(),
      () => setState('unverified'),
      { everyMs: RETRY_MS, forMs: CHECK_FOR_MS },
    );
  }, [waitingForProof, router]);
  useEffect(() => {
    if (verified || checkFailed) setState('idle');
  }, [verified, checkFailed]);
  useEffect(() => {
    if (!checkFailed) return;
    const retry = setTimeout(() => router.refresh(), RETRY_MS);
    return () => clearTimeout(retry);
  }, [checkFailed, router]);

  if (verified)
    return (
      <p className="an-gate-ok">
        <Icon name="shield" size={16} />
        Ownership of {account} verified: AI analysis is unlocked.
      </p>
    );

  if (checkFailed)
    return (
      <Gate
        tone="watch"
        title="We couldn't check your signature yet"
        body="The network did not answer in time. You don't need to sign again: the rules-based analysis stays until it does."
        action={
          <Button
            size="sm"
            disabled={checking}
            onClick={() => startChecking(() => router.refresh())}
          >
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        }
      />
    );

  if (connected !== account)
    return (
      <Gate
        title="AI analysis is only for the owner"
        body={`Connect the wallet of ${account} and sign a short ownership message to run it yourself.`}
      />
    );

  const busy = state === 'signing' || state === 'checking';
  return (
    <Gate
      title="Unlock AI analysis"
      body={`Sign a short message to prove you own ${account}. It is not a transaction: nothing is sent and no gas is paid.`}
      note={
        state === 'declined'
          ? 'Not signed: the rules-based analysis stays.'
          : state === 'unverified'
            ? 'Not verified yet: reload the page to check again.'
            : null
      }
      action={
        <Button
          variant="primary"
          disabled={busy}
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
        </Button>
      }
    />
  );
}

function Gate({
  tone = 'ai',
  title,
  body,
  note,
  action,
}: {
  tone?: 'ai' | 'watch';
  title: string;
  body: string;
  note?: string | null;
  action?: ReactNode;
}) {
  return (
    <div className={`an-gate an-gate-${tone}`} role="status">
      <span className="an-gate-ic">
        <Icon name="lock" size={18} />
      </span>
      <div>
        <p className="an-gate-t">{title}</p>
        <p className="an-gate-b">{body}</p>
        {note && <p className="an-gate-n">{note}</p>}
      </div>
      {action}
    </div>
  );
}
