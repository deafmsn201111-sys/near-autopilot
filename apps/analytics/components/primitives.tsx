'use client';
import { useId, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';

/** The design-system primitives from DESIGN.md → Components. Screens build from these, not page-local markup. */

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'md' | 'sm';
};

/** Primary is the one main action of a screen; secondary is the default; ghost is text-only. */
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('ds-btn', `ds-btn-${variant}`, size === 'sm' && 'ds-btn-sm', className)}
      {...rest}
    />
  );
}

const LOCK = (
  <svg data-icon="lock" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="18" height="11" x="3" y="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
const PEN = (
  <svg data-icon="pen" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

/** The only button that opens the user's wallet. Not ready → locked, with the reason said under it; `disabled` alone is busy. */
export function SignButton({
  ready,
  reason,
  className,
  children,
  disabled,
  ...rest
}: Omit<ButtonProps, 'variant' | 'size'> & { ready: boolean; reason?: ReactNode }) {
  const reasonId = useId();
  const showReason = !ready && reason;
  return (
    <>
      <button
        type="button"
        className={cx('ds-btn', 'ds-btn-sign', className)}
        disabled={!ready || disabled}
        aria-describedby={showReason ? reasonId : undefined}
        {...rest}
      >
        {ready ? PEN : LOCK}
        {children}
      </button>
      {showReason && (
        <p id={reasonId} className="ds-sign-reason">
          {reason}
        </p>
      )}
    </>
  );
}

export type ChipTone = 'safe' | 'watch' | 'act' | 'liq' | 'ai' | 'demo';

/** Neutral without a tone; tints only for risk, the AI, or demo (which also gets the hatched mark). */
export function Chip({
  tone,
  large,
  icon,
  children,
}: {
  tone?: ChipTone;
  large?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className={cx('ds-chip', tone && `ds-chip-${tone}`, large && 'ds-chip-lg')}>
      {tone === 'demo' && <span className="ds-hatch" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}

const PROVENANCE_LABEL = {
  on_chain: 'On-chain',
  estimate: 'Estimate',
  simulated: 'Simulated',
} as const;

/** Where a number came from: dot = on-chain, dashed ring = estimate, hatch = simulated. */
export function ProvenanceMark({
  kind,
  age,
  title,
  children,
}: {
  kind: keyof typeof PROVENANCE_LABEL;
  age?: string;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <span className={`ds-prov ds-prov-${kind}`} title={title}>
      {children ?? PROVENANCE_LABEL[kind]}
      {age && ` · ${age}`}
    </span>
  );
}

/** A bordered group in the page flow; flat, no shadow. */
export function Panel({
  label,
  busy,
  className,
  children,
}: {
  label: string;
  busy?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx('ds-panel', className)} aria-label={label} aria-busy={busy}>
      {children}
    </section>
  );
}

/** `top` is the #1 suggestion (raised, elev-1, 2px rule); `urgent` turns the rule and border orange. */
export function Card({
  top,
  urgent,
  className,
  style,
  children,
}: {
  top?: boolean;
  urgent?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <article
      className={cx('ds-card', top && 'ds-card-top', urgent && 'ds-card-act', className)}
      style={style}
    >
      {children}
    </article>
  );
}

/** Replaces a card's body after a confirmed transaction. Put it inside a live region that is already mounted. */
export function Receipt({ children }: { children: ReactNode }) {
  return <div className="ds-receipt">{children}</div>;
}

export interface Fact {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  good?: boolean;
}

export function FactsStrip({ items }: { items: readonly Fact[] }) {
  return (
    <dl className="ds-facts">
      {items.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd className={f.good ? 'good' : undefined}>
            {f.value}
            {f.sub && (
              <>
                {' '}
                <small>{f.sub}</small>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** How far collateral prices may fall before liquidation, in %: HF × (1 − f) = 1. */
export const bufferPct = (healthFactor: number) => Math.max(0, (1 - 1 / healthFactor) * 100);

const GAUGE_MAX = 60;
const onAxis = (pct: number) => `${+Math.min(100, (pct / GAUGE_MAX) * 100).toFixed(1)}%`;

/** The loan buffer against the strategy's urgent and safe thresholds (health factors), with its sentence. */
export function LoanGauge({
  healthFactor,
  urgentBelow,
  safeFrom,
  by = 'your collateral',
}: {
  healthFactor: number;
  urgentBelow: number;
  safeFrom: number;
  by?: string;
}) {
  const [buffer, urgent, safe] = [healthFactor, urgentBelow, safeFrom].map((hf) =>
    Math.round(bufferPct(hf)),
  ) as [number, number, number];
  return (
    <div className="ds-gauge-wrap">
      <div
        className="ds-gauge"
        role="img"
        aria-label={`Loan buffer ${buffer}%: urgent below ${urgent}%, safe from ${safe}%`}
      >
        <span className="ds-zone ds-zone-liq" style={{ width: onAxis(urgent) }} />
        <span
          className="ds-zone ds-zone-watch"
          style={{ left: onAxis(urgent), width: `calc(${onAxis(safe)} - ${onAxis(urgent)})` }}
        />
        <span className="ds-zone ds-zone-safe" style={{ left: onAxis(safe) }} />
        <span className="ds-mk ds-mk-first" style={{ left: 0 }}>
          <em>liquidation</em>
        </span>
        <span className="ds-mk ds-mk-up" style={{ left: onAxis(urgent) }}>
          <em>urgent {urgent}%</em>
        </span>
        <span className="ds-mk" style={{ left: onAxis(safe) }}>
          <em>safe {safe}%</em>
        </span>
        <span className="ds-gauge-you" style={{ left: onAxis(bufferPct(healthFactor)) }} />
      </div>
      <p className="ds-gauge-sentence">
        {healthFactor <= 1 ? (
          'The loan can be liquidated now.'
        ) : (
          <>
            Liquidation if {by} falls <b>{buffer}%</b>.
          </>
        )}
      </p>
    </div>
  );
}

/** A segmented control on native radios: arrow keys, form semantics and screen readers come for free. */
export function Segmented<V extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  legend: string;
  name: string;
  value: V;
  options: readonly { value: V; label: ReactNode }[];
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="ds-seg" disabled={disabled}>
      <legend className="sr-only">{legend}</legend>
      {options.map((o) => (
        <label key={o.value}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
