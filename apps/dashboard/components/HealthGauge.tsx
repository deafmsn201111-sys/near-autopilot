import { formatHealthFactor } from '../lib/format';

interface Props {
  healthFactor: number | null;
  trigger: number;
  target: number;
}

const MIN = 1;
const MAX = 3;
const LEFT = 24;
const WIDTH = 592;

const x = (hf: number): number =>
  LEFT + ((Math.min(Math.max(hf, MIN), MAX) - MIN) / (MAX - MIN)) * WIDTH;

/**
 * The page's one distinctive element: where the position sits between liquidation (1.00) and the
 * autopilot's own thresholds. Colour bands are redundant with the text labels.
 */
export function HealthGauge({ healthFactor, trigger, target }: Props) {
  if (healthFactor === null) {
    return (
      <p className="gauge-empty">
        No borrowed assets, so there is nothing to liquidate. The autopilot watches for new debt.
      </p>
    );
  }
  const markerX = x(healthFactor);
  const state = healthFactor < trigger ? 'below' : healthFactor < target ? 'between' : 'above';
  const summary =
    state === 'below'
      ? `Below the ${trigger.toFixed(2)} trigger: the autopilot is working to restore ${target.toFixed(2)}.`
      : state === 'between'
        ? `Above the ${trigger.toFixed(2)} trigger, below the ${target.toFixed(2)} target. No action needed yet.`
        : `Above the ${target.toFixed(2)} target.`;

  return (
    <figure className="gauge">
      <svg
        viewBox="0 0 640 104"
        role="img"
        aria-label={`Health factor ${formatHealthFactor(healthFactor)}. Liquidation at 1.00, autopilot trigger ${trigger.toFixed(2)}, target ${target.toFixed(2)}.`}
      >
        <rect x={x(MIN)} y={50} width={x(trigger) - x(MIN)} height={10} fill="var(--bad)" />
        <rect x={x(trigger)} y={50} width={x(target) - x(trigger)} height={10} fill="var(--warn)" />
        <rect x={x(target)} y={50} width={x(MAX) - x(target)} height={10} fill="var(--good)" />

        {[
          { hf: MIN, label: 'liquidation', align: 'start' as const },
          { hf: trigger, label: 'trigger', align: 'middle' as const },
          { hf: target, label: 'target', align: 'middle' as const },
        ].map((t) => (
          <g key={t.label}>
            <line x1={x(t.hf)} x2={x(t.hf)} y1={50} y2={70} stroke="var(--ink)" strokeWidth={1} />
            <text x={x(t.hf)} y={86} textAnchor={t.align} className="gauge-tick">
              {t.hf.toFixed(2)} {t.label}
            </text>
          </g>
        ))}

        <line x1={markerX} x2={markerX} y1={30} y2={60} stroke="var(--ink)" strokeWidth={3} />
        <text x={markerX} y={20} textAnchor="middle" className="gauge-value">
          {formatHealthFactor(healthFactor)}
        </text>
      </svg>
      <figcaption>{summary}</figcaption>
    </figure>
  );
}
