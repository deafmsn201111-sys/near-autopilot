'use client';
import { useEffect } from 'react';

/** A page crashed while rendering: say so plainly, keep the navigation, offer a retry. */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="state error-state" role="alert">
      <div className="state-icon" aria-hidden="true">
        ×
      </div>
      <div>
        <b>This page could not be shown.</b>
        <p>
          Something went wrong while preparing it. The stored data is not affected. Try again, or
          use the navigation to open another page.
        </p>
        {error.digest && <code className="state-code">reference {error.digest}</code>}
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn secondary" onClick={() => reset()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
