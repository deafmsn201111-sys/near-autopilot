'use client';
import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';

/** Re-reads the page's data from the API (a temporary error often clears on retry). */
export function RetryButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="ds-btn ds-btn-secondary ds-btn-sm"
      disabled={pending}
      onClick={() => start(() => router.refresh())}
    >
      {pending ? 'Retrying…' : label}
    </button>
  );
}

/** A data source failed: say which, why, and offer a retry. Never a bare "Error". */
export function ErrorState({
  what,
  error,
  hint,
}: {
  what: string;
  error: string | null;
  hint?: ReactNode;
}) {
  return (
    <div className="state error-state" role="alert">
      <div className="state-icon" aria-hidden="true">
        ×
      </div>
      <div>
        <b>{what} could not be loaded.</b>
        <p>
          {hint ??
            'The analytics API did not answer. Stored data is not lost; this is usually temporary.'}
        </p>
        {error && <code className="state-code">{error}</code>}
        <div style={{ marginTop: 10 }}>
          <RetryButton />
        </div>
      </div>
    </div>
  );
}

/**
 * A read failed but an older one is on screen, or the prices behind it stopped updating (#256): say how old it is and
 * why, and offer a retry. Amber, because the numbers may be off; never a blank page.
 */
export function StaleNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="stale-notice" role="status">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
      <p>
        <b>{title}</b> {detail}
      </p>
      <RetryButton />
    </div>
  );
}
