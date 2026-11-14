'use client';
import { useEffect, useRef } from 'react';
import type { StepState } from '../lib/sign-progress';

const ICON: Record<StepState['kind'], string> = {
  waiting: '•',
  signing: '✍',
  checking: '⏳',
  stopped: '–',
  sent: '↗',
  done: '✓',
  failed: '✗',
  unknown: '?',
};

function Detail({ s }: { s: StepState }) {
  if (s.kind === 'signing') return <span className="muted-note">Approve it in your wallet…</span>;
  if (s.kind === 'checking') return <span className="muted-note">Executing on NEAR…</span>;
  if (s.kind === 'stopped') return <span className="muted-note">Not signed: {s.reason}</span>;
  if (s.kind === 'sent')
    return (
      <a
        className="muted-note"
        href={`https://nearblocks.io/txns/${s.hash}`}
        target="_blank"
        rel="noreferrer"
      >
        Sent; not checked here. See it on NearBlocks
      </a>
    );
  if (s.kind === 'waiting' || !('result' in s)) return null;
  const r = s.result;
  return (
    <>
      {(r.status === 'confirmed' || r.status === 'failed') && r.lines.length > 0 && (
        <span>{r.lines.join(' · ')}</span>
      )}
      {r.status === 'failed' && (
        <span className="warn-text">
          Failed in <code>{r.failure.contract}</code>: {r.failure.error}. {r.funds}
        </span>
      )}
      {r.status === 'unknown' && <span className="muted-note">{r.reason}</span>}
      <a
        className="muted-note"
        href={`https://nearblocks.io/txns/${s.hash}`}
        target="_blank"
        rel="noreferrer"
      >
        {s.hash.slice(0, 8)}… on NearBlocks
      </a>
    </>
  );
}

/** Each signed step, in order: approved in the wallet, then executing, then what NEAR says happened. */
export function SignProgress({
  preview,
  steps,
  footer,
  busy,
  onClose,
}: {
  preview: readonly string[];
  steps: readonly StepState[];
  footer: string;
  busy: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => busy && e.preventDefault()}
      onClose={onClose}
    >
      <h3>
        {steps.length} {steps.length === 1 ? 'step' : 'steps'} to sign
      </h3>
      <ol className="prepare-steps">
        {steps.map((s, i) => (
          <li key={`${i}-${preview[i] ?? ''}`} className={`step-${s.kind}`}>
            <span className="step-idx" aria-label={s.kind}>
              {ICON[s.kind]}
            </span>
            <span className="step-text" style={{ display: 'grid', gap: 4 }}>
              <span>{preview[i] ?? `Step ${i + 1}`}</span>
              <Detail s={s} />
            </span>
          </li>
        ))}
      </ol>
      <p role="status">{footer}</p>
      <div className="modal-actions">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={() => ref.current?.close()}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
