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
}: {
  account: string;
  current: StrategyId;
  note?: string | null;
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
    <div className="strategy-picker" aria-busy={pending}>
      <span className="eyebrow">Strategy</span>
      <Segmented
        legend="Strategy"
        name="strategy"
        value={chosen}
        options={STRATEGY_IDS.map((id) => ({ value: id, label: STRATEGIES[id].label }))}
        onChange={choose}
      />
      <span className="muted-note">
        Safe loan from health factor <b>{s.healthyAt.toFixed(2)}</b>, one token up to{' '}
        <b>{s.concentrationInfoPct}%</b>. Repay back to <b>{s.targetHealthFactor.toFixed(2)}</b>;
        urgent below <b>{s.warningBelow.toFixed(2)}</b> or above <b>{s.concentrationWarningPct}%</b>{' '}
        in one token. Stablecoins never count as a concentration.
      </span>
      {note && <p className="strategy-note">{note}</p>}
    </div>
  );
}
