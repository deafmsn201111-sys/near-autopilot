'use client';
import { useRef, useState, useTransition } from 'react';

interface Result {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * A button that asks before it acts. The dialog says what will happen and what will NOT (nothing is ever sent), and
 * asks for a reason when the change is recorded in the audit trail. The result is shown in words, success or not.
 */
export function ConfirmAction(p: {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'primary' | 'secondary' | 'danger';
  needsReason?: boolean;
  action: (reason: string) => Promise<Result>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [pending, start] = useTransition();
  const ready = !p.needsReason || reason.trim().length >= 3;
  return (
    <>
      <button
        type="button"
        className={`btn ${p.tone ?? 'secondary'}`}
        onClick={() => {
          setResult(null);
          dialog.current?.showModal();
        }}
      >
        {p.label}
      </button>
      {result && (
        <p className={`action-result ${result.ok ? 'ok' : 'fail'}`} role="status">
          {result.ok ? '✓ ' : '× '}
          {result.message}
        </p>
      )}
      <dialog ref={dialog} className="modal" aria-labelledby={`${p.label}-title`}>
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            start(async () => {
              const r = await p.action(reason.trim());
              setResult(r);
              if (r.ok) setReason('');
              dialog.current?.close();
            });
          }}
        >
          <h3 id={`${p.label}-title`}>{p.title}</h3>
          <p>{p.description}</p>
          {p.needsReason && (
            <label className="field">
              Reason (recorded in the audit trail)
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. maintenance, investigating a price alert"
                minLength={3}
                maxLength={300}
                required
                autoFocus
              />
            </label>
          )}
          <div className="modal-actions">
            <button type="button" className="btn secondary" onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn ${p.tone ?? 'primary'}`}
              disabled={!ready || pending}
            >
              {pending ? 'Working…' : p.confirmLabel}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
