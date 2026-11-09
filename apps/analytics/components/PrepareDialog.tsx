'use client';
import { useState } from 'react';
import { prepareIntent } from '../lib/prepare-client';
import { gasToTgas, shortAccount, totalDepositNear, yoctoToNear } from '../lib/prepare-format';
import type { PrepareRequest, PreparedCascade } from '../lib/prepare-types';

/**
 * One-click preview: given a recommendation's intent and the connected account, ask the server to ASSEMBLE the exact
 * transaction cascade and show the user precisely what they would sign — plain-language steps plus the receiver,
 * method, attached deposit and gas of every action. Nothing is signed here: the server holds no key, and the wallet
 * hand-off is enabled only in local mode (shown as a clear, honest note) until the post-hackathon security review.
 */
export function PrepareDialog({ request, label }: { request: PrepareRequest; label: string }) {
  const [state, setState] = useState<'idle' | 'loading'>('idle');
  const [cascade, setCascade] = useState<PreparedCascade | null>(null);
  const [error, setError] = useState<{ message: string; reasons?: readonly string[] } | null>(null);

  async function run() {
    setState('loading');
    setError(null);
    setCascade(null);
    const r = await prepareIntent(request);
    if (r.ok) setCascade(r.cascade);
    else setError({ message: r.error, ...(r.reasons ? { reasons: r.reasons } : {}) });
    setState('idle');
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
          <ol className="prepare-steps">
            {cascade.preview.map((line, i) => (
              <li key={`${i}-${line.slice(0, 16)}`}>{line}</li>
            ))}
          </ol>

          <details className="plan">
            <summary>
              Exactly what you would sign — {cascade.transactions.length}{' '}
              {cascade.transactions.length === 1 ? 'transaction' : 'transactions'},{' '}
              {totalDepositNear(cascade.transactions)} NEAR attached
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
                            {yoctoToNear(a.deposit)} NEAR · {gasToTgas(a.gas)}
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
            <button type="button" className="btn primary small" disabled title={cascade.note}>
              🔒 Sign in your wallet
            </button>
            <span className="muted-note">
              The cascade above is ready. One-click signing in your own wallet turns on in local
              mode after the security review — the server never holds a key and sends nothing.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
