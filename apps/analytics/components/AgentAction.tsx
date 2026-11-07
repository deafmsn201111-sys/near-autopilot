'use client';
import { useRef, useState, useTransition } from 'react';
import {
  confirmAgentAction,
  requestAgentAction,
  type RequestOutcome,
} from '../app/request-actions';

const ICON = { done: '✓', blocked: '×', needs_approval: '!', failed: '×' } as const;

/**
 * "Let the agent do it" on a demo portfolio: choose the amount, the agent plans it, the safety policy checks it,
 * and it runs as a dry run. Above the auto-approval threshold the policy asks you to confirm; a block is final.
 */
export function AgentAction(p: {
  portfolio: string;
  actionId: string;
  title: string;
  defaultUsd: number;
  maxUsd: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [usd, setUsd] = useState(String(Math.max(1, Math.floor(p.defaultUsd))));
  const [result, setResult] = useState<RequestOutcome | null>(null);
  const [pending, start] = useTransition();
  const value = Number(usd);
  const valid = Number.isFinite(value) && value > 0 && value <= p.maxUsd;
  return (
    <>
      <button
        type="button"
        className="btn primary small"
        onClick={() => {
          setResult(null);
          dialog.current?.showModal();
        }}
      >
        Let the agent do it
      </button>
      <dialog ref={dialog} className="modal" aria-label={p.title}>
        <h3>{p.title}</h3>
        {!result ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (valid)
                start(async () =>
                  setResult(await requestAgentAction(p.portfolio, p.actionId, value)),
                );
            }}
          >
            <p>
              The agent plans it, the safety policy runs its 12 checks, and it is executed as a{' '}
              <b>dry run</b>: nothing is signed or sent. Up to $50 runs automatically; above that
              the policy asks you to confirm; above $100 it is blocked.
            </p>
            <label className="field">
              Amount in USD (up to {Math.floor(p.maxUsd).toLocaleString('en-US')})
              <input
                inputMode="decimal"
                value={usd}
                onChange={(e) => setUsd(e.target.value)}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!valid || pending}>
                {pending ? 'Checking…' : 'Ask the agent'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <p className={`verdict ${result.status === 'done' ? 'good' : 'warning'}`}>
              <i aria-hidden="true">{ICON[result.status]}</i>
              {result.sentence}
            </p>
            {result.reasons.length > 0 && (
              <ul className="muted-note">
                {result.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              {result.status === 'needs_approval' && result.id && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={pending}
                  onClick={() => {
                    const id = result.id ?? '';
                    start(async () => setResult(await confirmAgentAction(p.portfolio, id)));
                  }}
                >
                  {pending ? 'Running…' : 'I confirm, run it'}
                </button>
              )}
              <button
                type="button"
                className="btn secondary"
                onClick={() => dialog.current?.close()}
              >
                Close
              </button>
            </div>
            {result.status === 'done' && (
              <p className="muted-note">It is now in Activity and in the audit trail.</p>
            )}
          </div>
        )}
      </dialog>
    </>
  );
}
