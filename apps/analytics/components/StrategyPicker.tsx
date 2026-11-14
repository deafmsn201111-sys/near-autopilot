'use client';
import { useRouter } from 'next/navigation';
import { useOptimistic, useTransition } from 'react';
import { STRATEGIES, STRATEGY_IDS, type StrategyId } from '@near-autopilot/core/strategy';
import { saveStrategy } from '../app/account-actions';
import { Segmented } from './primitives';

/** The risk preset for "Your account": the cards, repay amounts and the AI ranking follow it. */
export function StrategyPicker({
  account,
  current,
  note,
  disabled,
}: {
  account: string;
  current: StrategyId;
  note?: string | null;
  /** While an AI run is going: its result belongs to the strategy it started with. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useOptimistic(current);
  const s = STRATEGIES[chosen];

  const choose = (id: StrategyId) =>
    startTransition(async () => {
      setChosen(id);
      await saveStrategy(account, id);
      router.push(`/?p=account&account=${encodeURIComponent(account)}&strategy=${id}`);
    });

  return (
    <div className={`an-strat${pending ? ' is-pending' : ''}`} aria-busy={pending}>
      <span className="an-strat-label" aria-hidden="true">
        Risk strategy
      </span>
      <Segmented
        legend="Risk strategy"
        name="strategy"
        value={chosen}
        options={STRATEGY_IDS.map((id) => ({ value: id, label: STRATEGIES[id].label }))}
        onChange={choose}
        disabled={disabled}
      />
      <p className="an-strat-why" aria-live="polite">
        {pending && <span className="an-strat-busy">Re-ranking… </span>}
        Loan safe from health factor <b>{s.healthyAt.toFixed(2)}</b>, repaid back to{' '}
        <b>{s.targetHealthFactor.toFixed(2)}</b>, urgent below <b>{s.warningBelow.toFixed(2)}</b> ·
        one token up to <b>{s.concentrationInfoPct}%</b>, urgent above{' '}
        <b>{s.concentrationWarningPct}%</b> (stablecoins never count). Changes every number below.
      </p>
      {note && <p className="strategy-note">{note}</p>}
    </div>
  );
}
