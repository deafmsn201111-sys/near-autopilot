'use client';
import { useEffect, useState } from 'react';

/** Copies `text`; the label says "Copied" for a moment, announced to screen readers, or why it could not. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 2_000);
    return () => clearTimeout(t);
  }, [said]);
  return (
    <button
      type="button"
      className="ds-btn ds-btn-secondary ds-btn-sm"
      onClick={() =>
        void (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard')))
          .then(() => setSaid('Copied'))
          .catch(() => setSaid('Copy failed: select it by hand'))
      }
    >
      <span aria-live="polite">{said ?? label}</span>
    </button>
  );
}
