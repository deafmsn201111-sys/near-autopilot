'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { refreshAccount } from '../app/account-actions';
import { prepareIntent } from '../lib/prepare-client';
import {
  gasToTgas,
  shortAccount,
  totalDepositNear,
  trimDecimals,
  yoctoToNear,
} from '../lib/prepare-format';
import type { PrepareRequest, PreparedCascade } from '../lib/prepare-types';
import { signCascade, type SignResult } from '../lib/wallet-sign';

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
}: {
  request: PrepareRequest;
  label: string;
  signingEnabled?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'loading' | 'signing' | 'updating'>('idle');
  const [cascade, setCascade] = useState<PreparedCascade | null>(null);
  const [error, setError] = useState<{ message: string; reasons?: readonly string[] } | null>(null);
  const [signed, setSigned] = useState<SignResult | null>(null);

  async function run() {
    setState('loading');
    setError(null);
    setCascade(null);
    setSigned(null);
    const r = await prepareIntent(request);
    if (r.ok) setCascade(r.cascade);
    else setError({ message: r.error, ...(r.reasons ? { reasons: r.reasons } : {}) });
    setState('idle');
  }

  async function sign() {
    if (!cascade) return;
    setState('signing');
    setSigned(null);
    const r = await signCascade(cascade.transactions, request.account, signingEnabled);
    setSigned(r);
    if (r.ok) {
      // The transactions are on-chain; give them a moment to reach finality, then refresh the portfolio so the
      // balances, allocation and this recommendation reflect the new state (the card updates or disappears).
      setState('updating');
      await new Promise((res) => setTimeout(res, 4000));
      setCascade(null); // collapse the (now spent) preview; the user can prepare a fresh one if still suggested
      await refreshAccount(request.account).catch(() => undefined);
      router.refresh();
      setState('idle');
    } else {
      setState('idle');
    }
  }

  return (
    <div className="prepare">
      <button
        type="button"
        className="btn primary small"
        onClick={() => void run()}
        disabled={state === 'loading'}
      >
        {state === 'loading' ? 'Building transaction…' : label}
      </button>

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
              <div className="pa-facts">
                <div>
                  <span>Steps to sign</span>
                  <b>{cascade.transactions.length}</b>
                </div>
                <div>
                  <span>NEAR attached</span>
                  <b>{trimDecimals(totalDepositNear(cascade.transactions))}</b>
                </div>
              </div>
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
            {signingEnabled ? (
              <>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() => void sign()}
                  disabled={state === 'signing' || state === 'updating'}
                >
                  {state === 'signing'
                    ? 'Waiting for your wallet…'
                    : state === 'updating'
                      ? 'Updating portfolio…'
                      : 'Sign in your wallet'}
                </button>
                <span className="muted-note">
                  {cascade.transactions.length}{' '}
                  {cascade.transactions.length === 1 ? 'transaction' : 'transactions'}, signed by
                  you. Autopilot never holds your keys or moves funds on its own.
                </span>
              </>
            ) : (
              <>
                <button type="button" className="btn primary small" disabled title={cascade.note}>
                  🔒 Sign in your wallet
                </button>
                <span className="muted-note">
                  {cascade.transactions.length}{' '}
                  {cascade.transactions.length === 1 ? 'transaction' : 'transactions'}, signed by
                  you. Autopilot never holds your keys or moves funds on its own.
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {signed && (
        <div
          className={`callout${signed.ok ? '' : ' warn'}`}
          role="status"
          style={{ marginTop: 10 }}
        >
          {signed.ok ? (
            <b>{state === 'updating' ? 'Signed. Updating portfolio…' : 'Signed and sent.'}</b>
          ) : (
            <>
              <b>Stopped:</b> {signed.reason}
            </>
          )}
          {signed.hashes.length > 0 && (
            <ul className="muted-note" style={{ margin: '6px 0 0' }}>
              {signed.hashes.map((h) => (
                <li key={h}>
                  <a href={`https://nearblocks.io/txns/${h}`} target="_blank" rel="noreferrer">
                    {h.slice(0, 10)}… — verify on NearBlocks
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
