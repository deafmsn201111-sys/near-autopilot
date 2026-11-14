'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { refreshAccount } from '../app/account-actions';
import { refreshPortfolio } from '../lib/portfolio-refresh';
import { prepareIntent } from '../lib/prepare-client';
import {
  gasToTgas,
  shortAccount,
  totalDepositNear,
  trimDecimals,
  yoctoToNear,
} from '../lib/prepare-format';
import type { PrepareRequest, PreparedCascade } from '../lib/prepare-types';
import { confirmStep } from '../lib/events-client';
import { mayContinue, progressFooter, stepAfterCheck, type StepState } from '../lib/sign-progress';
import { withoutModal } from '../lib/modal';
import { signCascade } from '../lib/wallet-sign';
import { SignProgress } from './SignProgress';
import { Button, FactsStrip, SignButton } from './primitives';

/** The sized amounts a cascade reports, for the compact "After this move" panel. Display only — the real
 *  per-action deposits and gas stay in the "Exactly what you would sign" table; nothing here is fabricated. */
function prepareAmounts(c: PreparedCascade): { label: string; human: number; symbol: string }[] {
  const sized = c.amounts ?? (c.amount ? [c.amount] : []);
  const out: { label: string; human: number; symbol: string }[] = [];
  for (const a of sized) out.push({ label: '≈', human: a.human, symbol: a.symbol });
  for (const f of c.freed ?? []) out.push({ label: 'frees', human: f.human, symbol: f.symbol });
  return out;
}

/**
 * One-click: given a recommendation's intent and the connected account, ask the server to ASSEMBLE the exact
 * transaction cascade and show the user precisely what they would sign — plain-language steps plus the receiver,
 * method, attached deposit and gas of every action. When signing is enabled (a flag, never on the public demo), the
 * "Sign" button hands the cascade to the connected wallet, which shows every action again for approval. The server
 * holds no key and sends nothing; it only assembled the transactions.
 */
export function PrepareDialog({
  request,
  label,
  signingEnabled = false,
  once = false,
}: {
  request: PrepareRequest;
  label: string;
  signingEnabled?: boolean;
  /** One payment (a 1Click withdrawal): after one signing attempt it is never offered to sign or build again. */
  once?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'signing' | 'updating'>('idle');
  const [cascade, setCascade] = useState<PreparedCascade | null>(null);
  const [spent, setSpent] = useState<'sent' | 'tried' | null>(null);
  const [error, setError] = useState<{ message: string; reasons?: readonly string[] } | null>(null);
  const [progress, setProgress] = useState<{
    preview: readonly string[];
    steps: StepState[];
  } | null>(null);

  async function run() {
    setState('loading');
    setError(null);
    setCascade(null);
    setProgress(null);
    const r = await prepareIntent(request);
    if (r.ok) setCascade(r.cascade);
    else setError({ message: r.error, ...(r.reasons ? { reasons: r.reasons } : {}) });
    setState('idle');
  }

  async function sign(dialog: HTMLDialogElement | null) {
    if (!cascade) return;
    const { cascadeId, transactions, preview } = cascade;
    setState('signing');
    setProgress({ preview, steps: transactions.map(() => ({ kind: 'waiting' })) });
    const setStep = (i: number, s: StepState) =>
      setProgress((p) => p && { ...p, steps: p.steps.map((x, j) => (j === i ? s : x)) });
    let at = 0;
    const r = await withoutModal(dialog, () =>
      signCascade(transactions, request.account, signingEnabled, {
        onSigning: (i) => {
          at = i;
          setStep(i, { kind: 'signing' });
        },
        onSent: async (i, hash) => {
          setStep(i, { kind: 'checking', hash });
          const result = cascadeId
            ? await confirmStep({ account: request.account, cascadeId, step: i, hash })
            : ({ status: 'unknown', reason: 'This server cannot confirm steps.' } as const);
          const next = stepAfterCheck(hash, result);
          setStep(i, next);
          return mayContinue(next);
        },
      }),
    );
    if (!r.ok && r.hashes.length === at)
      setStep(at, { kind: 'stopped', reason: r.reason ?? 'declined in the wallet' });
    // A wallet may broadcast and still fail or return no hash: any attempt spends a one-payment cascade.
    if (once) {
      setSpent(r.hashes.length > 0 ? 'sent' : 'tried');
      setCascade(null);
    }
    if (r.ok) {
      // The transactions are on-chain: refresh the portfolio until the balances, allocation and this recommendation
      // show the new state (the card updates or disappears).
      setState('updating');
      setCascade(null); // collapse the (now spent) preview; the user can prepare a fresh one if still suggested
      await refreshPortfolio(request.account, refreshAccount, () => router.refresh());
    }
    setState('idle');
  }

  return (
    <div className="prepare">
      {spent ? (
        <p className="muted-note">
          {spent === 'sent'
            ? 'Sent from your wallet. Do not send it again; the status above follows it.'
            : 'Not sent, as far as the wallet reported. Check your wallet activity; to try again, get a new quote.'}
        </p>
      ) : (
        <Button
          variant="primary"
          size="sm"
          onClick={() => void run()}
          disabled={state === 'loading'}
        >
          {state === 'loading' ? 'Building transaction…' : label}
        </Button>
      )}

      {error && (
        <div className="callout warn" role="alert" style={{ marginTop: 10 }}>
          <b>Can’t build this safely:</b> {error.message}
          {error.reasons && error.reasons.length > 0 && (
            <ul className="muted-note" style={{ margin: '6px 0 0' }}>
              {error.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {cascade && (
        <div className="prepare-result" style={{ marginTop: 10 }}>
          <div className="prepare-head">
            <span className="prepare-kicker">
              Transaction cascade · {cascade.transactions.length}{' '}
              {cascade.transactions.length === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <div className="prepare-body">
            <ol className="prepare-steps">
              {cascade.preview.map((line, i) => (
                <li key={`${i}-${line.slice(0, 16)}`}>
                  <span className="step-idx">{i + 1}</span>
                  <span className="step-text">{line}</span>
                </li>
              ))}
            </ol>
            <aside className="prepare-after">
              <div className="pa-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M4 18 10 12l4 4 6-7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                After this move
              </div>
              {prepareAmounts(cascade).length > 0 && (
                <div className="pa-amts">
                  {prepareAmounts(cascade).map((a) => (
                    <span className="pa-tok" key={`${a.label}-${a.symbol}`}>
                      <span className="pa-tok-ci">{a.symbol.slice(0, 1)}</span>
                      {a.label} {trimDecimals(String(a.human), 4)} {a.symbol}
                    </span>
                  ))}
                </div>
              )}
              <FactsStrip
                items={[
                  { label: 'Steps to sign', value: cascade.transactions.length },
                  {
                    label: 'NEAR attached',
                    value: trimDecimals(totalDepositNear(cascade.transactions)),
                  },
                ]}
              />
            </aside>
          </div>

          <details className="plan">
            <summary>
              Exactly what you would sign — {cascade.transactions.length}{' '}
              {cascade.transactions.length === 1 ? 'transaction' : 'transactions'},{' '}
              {trimDecimals(totalDepositNear(cascade.transactions))} NEAR attached
            </summary>
            <div className="prepare-txs">
              {cascade.transactions.map((tx, ti) => (
                <div className="prepare-tx" key={tx.intentId}>
                  <div className="eyebrow">
                    {ti + 1}. to <code title={tx.receiverId}>{shortAccount(tx.receiverId)}</code>
                  </div>
                  <table className="mini">
                    <tbody>
                      {tx.actions.map((a, ai) => (
                        <tr key={`${a.methodName}-${ai}`}>
                          <td>
                            <code>{a.methodName}</code>
                          </td>
                          <td className="num">
                            {trimDecimals(yoctoToNear(a.deposit))} NEAR · {gasToTgas(a.gas)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </details>

          <div className="prepare-sign">
            <SignButton
              ready={signingEnabled}
              disabled={state === 'signing' || state === 'updating'}
              reason={cascade.note}
              onClick={(e) => void sign(e.currentTarget.closest('dialog'))}
            >
              {state === 'signing'
                ? 'Waiting for your wallet…'
                : state === 'updating'
                  ? 'Updating portfolio…'
                  : 'Sign in your wallet'}
            </SignButton>
            <span className="muted-note">
              {cascade.transactions.length}{' '}
              {cascade.transactions.length === 1 ? 'transaction' : 'transactions'}, signed by you.
              Autopilot never holds your keys or moves funds on its own. Review every action in your
              wallet: you are responsible for what you sign.
            </span>
          </div>
        </div>
      )}

      {progress && (
        <SignProgress
          preview={progress.preview}
          steps={progress.steps}
          busy={state === 'signing'}
          footer={
            state === 'updating'
              ? 'Done. Updating your portfolio…'
              : progressFooter(progress.steps, state === 'signing')
          }
          onClose={() => setProgress(null)}
        />
      )}
    </div>
  );
}
