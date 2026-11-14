import type { CSSProperties, ReactNode } from 'react';
import type { PortfolioView } from '../lib/product';
import { money, signedMoney } from '../lib/format';
import { CountUp } from './CountUp';
import { Chip, LoanGauge, ProvenanceMark, type ChipTone } from './primitives';
import { TokenIcon, TokenIcons } from './TokenIcon';

interface AllocItem {
  key: string;
  symbol: string;
  /** An unverified token may copy a real symbol: it never gets the real token's colour. */
  verified: boolean;
  pct: number;
  icon: string | null;
}

/** Token colours live only in the allocation bar, always next to the token's icon (DESIGN.md → Colors). */
const TOKEN_COLOUR: Record<string, string> = {
  NEAR: '#00e29a',
  WNEAR: '#00e29a',
  USDT: '#26a17b',
  'USDT.E': '#7fd4b8',
  USDC: '#2775ca',
  'USDC.E': '#7ab0eb',
  STNEAR: '#a5a8b3',
  ETH: '#7b8ff0',
};
const FALLBACK = ['var(--series-4)', 'var(--series-5)'];
const TOP_TOKENS = 4;

export const allocSegments = (alloc: readonly AllocItem[]) => {
  const other = alloc.slice(TOP_TOKENS).reduce((s, a) => s + a.pct, 0);
  let unknown = 0;
  return [
    ...alloc.slice(0, TOP_TOKENS).map((a) => ({
      ...a,
      color: (a.verified && TOKEN_COLOUR[a.symbol.toUpperCase()]) || FALLBACK[unknown++ % 2]!,
    })),
    ...(other > 0.0005
      ? [
          {
            key: 'other',
            symbol: 'Other',
            verified: true,
            pct: other,
            icon: null,
            color: 'var(--series-5)',
          },
        ]
      : []),
  ];
};

type Health = PortfolioView['health'];

const LEVEL_TONE = { low: 'safe', medium: 'watch', high: 'act' } as const;

/** "Unknown" (no health factor, not low) stays neutral; a loan at or below 1 is liquidation red. */
const healthTone = ({ healthFactor, level }: Health): ChipTone | undefined =>
  healthFactor === null
    ? level === 'low'
      ? 'safe'
      : undefined
    : healthFactor <= 1
      ? 'liq'
      : LEVEL_TONE[level];

const icon = (name: string, d: ReactNode) => (
  <svg data-icon={name} viewBox="0 0 24 24" aria-hidden="true">
    {d}
  </svg>
);
const TREND_UP = icon('trend-up', <path d="m22 7-8.5 8.5-5-5L2 17M16 7h6v6" />);
const TREND_DOWN = icon('trend-down', <path d="m22 17-8.5-8.5-5 5L2 7M16 17h6v-6" />);
const ALERT = icon(
  'alert',
  <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01" />,
);
const TONE_ICON: Partial<Record<ChipTone, ReactNode>> = {
  safe: icon('check', <path d="M20 6 9 17l-5-5" />),
  watch: icon(
    'alert-circle',
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </>,
  ),
  act: ALERT,
  liq: ALERT,
};

function LoanCell({ health, by, source }: { health: Health; by: string; source: ReactNode }) {
  if (health.healthFactor === null)
    return (
      <div>
        <span className="sum-lbl">Loan safety {source}</span>
        <span className="sum-kpi">{health.label}</span>
        <span className="sum-sub">{health.sentence}</span>
      </div>
    );
  const tone = healthTone(health);
  return (
    <div>
      <span className="sum-lbl">Loan safety {source}</span>
      <div className="sum-safe">
        <Chip tone={tone} large icon={tone && TONE_ICON[tone]}>
          {health.label}
        </Chip>
        <span className="sum-sub num">Health factor {health.healthFactor.toFixed(2)}</span>
      </div>
      {health.urgentBelow !== undefined && health.safeFrom !== undefined ? (
        <LoanGauge
          healthFactor={health.healthFactor}
          urgentBelow={health.urgentBelow}
          safeFrom={health.safeFrom}
          by={by}
        />
      ) : (
        <span className="sum-sub">{health.sentence}</span>
      )}
    </div>
  );
}

/** The portfolio summary on the page: net worth first, then the monthly result and loan safety. */
export function PortfolioSummary({
  netWorthUsd,
  assetsUsd,
  debtUsd,
  source,
  alloc,
  monthly,
  health,
  loanBy,
  actions,
  other,
}: {
  netWorthUsd: number;
  assetsUsd: number;
  debtUsd: number;
  source: { kind: 'on_chain' | 'simulated'; age: string };
  alloc: readonly AllocItem[];
  monthly: { usd: number | null; sentence: string };
  health: Health;
  loanBy: string;
  actions?: ReactNode;
  /** Balances on other chains (HOT Kit): shown, not analysed. Absent while there is no data. */
  other?: {
    usd: number;
    tokens: readonly { icon: string | null; symbol: string }[];
    action: ReactNode;
  } | null;
}) {
  const src = <ProvenanceMark kind={source.kind} age={source.age} />;
  const segs = allocSegments(alloc);
  const m = signedMoney(monthly.usd);
  const trend = m.tone === 'pos' ? 'up' : m.tone === 'neg' ? 'down' : '';
  return (
    <section className="sum" aria-label="Summary">
      <div>
        <span className="sum-lbl">Net worth {src}</span>
        <span className="sum-total num">
          <CountUp value={netWorthUsd} kind="money" />
        </span>
        <span className="sum-sub num">
          {money(assetsUsd)} in assets
          {debtUsd >= 0.005 && ` − ${money(debtUsd)} borrowed`}
        </span>
        {segs.length > 0 && (
          <>
            <div className="sum-alloc" aria-hidden="true">
              {segs.map((s) => (
                <span key={s.key} style={{ width: `${s.pct * 100}%`, background: s.color }} />
              ))}
            </div>
            <div className="sum-legend">
              {segs.map((s) => (
                <span key={s.key} style={{ '--sw': s.color } as CSSProperties}>
                  <TokenIcon icon={s.icon} symbol={s.symbol} size={16} />
                  <b>{s.symbol}</b> {(s.pct * 100).toFixed(1)}%
                </span>
              ))}
            </div>
          </>
        )}
        {other && (
          <div className="sum-other">
            <TokenIcons tokens={other.tokens} size={16} />
            <span>
              <b className="num">+ {money(other.usd, false)}</b> on other chains · not analysed
            </span>
            {other.action}
          </div>
        )}
        {actions && <div className="sum-acts">{actions}</div>}
      </div>
      <div>
        <span className="sum-lbl">
          Each month <ProvenanceMark kind="estimate">Estimate · protocol rates</ProvenanceMark>
        </span>
        <span className={`sum-kpi num ${trend}`}>
          {trend === 'up' ? TREND_UP : trend === 'down' ? TREND_DOWN : null}
          {monthly.usd === null ? '—' : <CountUp value={monthly.usd} kind="signed" />}
        </span>
        <span className="sum-sub">{monthly.sentence}</span>
      </div>
      <LoanCell
        health={health}
        by={loanBy}
        source={
          <ProvenanceMark
            kind={source.kind === 'simulated' ? 'simulated' : 'estimate'}
            age={source.age}
          />
        }
      />
    </section>
  );
}
