'use client';
import { useRouter } from 'next/navigation';

export type Mode = 'demo' | 'confirm' | 'auto';
export const MODES: readonly { id: Mode; label: string; note: string }[] = [
  {
    id: 'demo',
    label: 'Demo',
    note: 'Simulated portfolios on real prices; the agent acts as a dry run.',
  },
  {
    id: 'confirm',
    label: 'Mainnet · confirm each',
    note: 'Your wallet signs every transaction. Locked until the final security tests.',
  },
  {
    id: 'auto',
    label: 'Mainnet · autopilot',
    note: 'The agent acts within your on-chain limits. Needs the guard contract (roadmap).',
  },
];

/** The operating mode, kept in a cookie so the server renders the right buttons. */
export function ModeSwitch({ current }: { current: Mode }) {
  const router = useRouter();
  return (
    <nav className="segmented mode-switch" aria-label="Operating mode">
      {MODES.map((m) => (
        <a
          key={m.id}
          href="#"
          className={m.id !== 'demo' ? 'locked' : undefined}
          data-tip={m.note}
          aria-current={m.id === current ? 'true' : undefined}
          onClick={(e) => {
            e.preventDefault();
            document.cookie = `autopilot-mode=${m.id}; path=/; max-age=31536000; samesite=lax`;
            router.refresh();
          }}
        >
          {m.id !== 'demo' && <span aria-hidden="true">🔒 </span>}
          {m.label}
        </a>
      ))}
    </nav>
  );
}
