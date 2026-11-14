'use client';
import { useEffect } from 'react';

/** The last rows seen per scope; survives router.refresh, so a refresh after a transaction can tell what changed. */
const seen = new Map<string, string>();

const FLASH: Keyframe[] = [{ background: 'var(--safe-bg)' }, { background: 'transparent' }];

/** Flashes each `[data-row]` whose value changed since the last render, once, after any open sheet has closed. */
export function RowFlash({
  scope,
  rows,
}: {
  scope: string;
  rows: readonly (readonly [key: string, value: string])[];
}) {
  const signature = JSON.stringify(rows);
  useEffect(() => {
    const before = seen.get(scope);
    seen.set(scope, signature);
    if (!before || before === signature) return;
    const old = new Map(JSON.parse(before) as [string, string][]);
    const now = JSON.parse(signature) as [string, string][];
    const changed = now.filter(([k, v]) => old.get(k) !== v).map(([k]) => k);
    if (changed.length === 0) return;
    const flash = () => {
      for (const k of changed)
        document
          .querySelector(`[data-row="${CSS.escape(k)}"]`)
          ?.animate(FLASH, { duration: 1600, easing: 'cubic-bezier(.16,1,.3,1)' });
    };
    const sheet = document.querySelector('dialog[open]');
    // Not removed on a re-render: a second refresh while the sheet is open must not cancel this diff.
    if (sheet) sheet.addEventListener('close', flash, { once: true });
    else flash();
  }, [scope, signature]);
  return null;
}
