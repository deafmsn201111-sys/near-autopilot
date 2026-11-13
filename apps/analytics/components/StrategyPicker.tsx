'use client';
import Link from 'next/link';
import { useTransition } from 'react';
import { STRATEGIES, STRATEGY_IDS, type StrategyId } from '@near-autopilot/core/strategy';
import { saveStrategy } from '../app/account-actions';

/** The risk preset for "Your account": the cards, repay amounts and the AI ranking follow it. */
export function StrategyPicker({
  account,
  current,
  note,
}: {
  account: string;
  current: StrategyId;
  note?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const href = (id: StrategyId) =>
    `/?p=account&account=${encodeURIComponent(account)}&strategy=${id}`;

  return (
    <div className="strategy-picker">
      <span className="eyebrow">Strategy</span>
      <nav className="segmented" aria-label="Strategy" aria-busy={pending}>
        {STRATEGY_IDS.map((id) => {
          const s = STRATEGIES[id];
          return (
            <Link
              key={id}
              href={href(id)}
              aria-current={id === current ? 'true' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                startTransition(async () => {
                  await saveStrategy(account, id);
                  // The account panel is rendered from two server reads (portfolio and agent advice).
                  // A hard navigation ensures both reads use this strategy instead of reusing a cached RSC payload.
                  window.location.assign(href(id));
                });
              }}
            >
              {s.label}
              <small className="strategy-lines">
                safe loan ≥ {s.healthyAt.toFixed(2)} · one token ≤ {s.concentrationInfoPct}%
              </small>
            </Link>
          );
        })}
      </nav>
      <span className="muted-note">
        Repay back to health factor {STRATEGIES[current].targetHealthFactor.toFixed(2)}; urgent
        below {STRATEGIES[current].warningBelow.toFixed(2)} or above{' '}
        {STRATEGIES[current].concentrationWarningPct}% in one token. Stablecoins never count as a
        concentration.
      </span>
      {note && <p className="strategy-note">{note}</p>}
    </div>
  );
}
