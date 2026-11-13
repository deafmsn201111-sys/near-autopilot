'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { STRATEGIES, STRATEGY_IDS, type StrategyId } from '@near-autopilot/core/strategy';
import { saveStrategy } from '../app/account-actions';

/** The risk preset for "Your account": the cards, repay amounts and the AI ranking follow it. */
export function StrategyPicker({ account, current }: { account: string; current: StrategyId }) {
  const router = useRouter();
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
                e.preventDefault();
                startTransition(async () => {
                  await saveStrategy(account, id);
                  router.push(href(id));
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
    </div>
  );
}
