import type { ReactNode } from 'react';
import { money } from '../lib/format';
import { ALERT, MINUS, TREND_DOWN, TREND_UP } from './icons';
import { Chip, ProvenanceMark } from './primitives';
import { RowFlash } from './RowFlash';
import { TokenIcons } from './TokenIcon';

type Logo = { icon: string | null; symbol: string };

export interface HoldingInput {
  where: 'wallet' | 'collateral' | 'deposited' | 'borrowed';
  token?: string;
  symbol: string;
  amount: number;
  usd: number | null;
  verified?: boolean;
  estimate?: boolean;
  small?: boolean;
  aprPct?: number | null;
  logos?: readonly Logo[];
}

export interface PositionInput {
  key: string;
  label: string;
  sub: string;
  amount: number | null;
  usd: number | null;
  verified?: boolean;
  estimate?: boolean;
  small?: boolean;
  kind?: 'v1' | 'dcl' | 'staking' | 'unstaking' | 'order';
  inRange?: boolean;
  logos?: readonly Logo[];
}

export interface Status {
  label: string;
  tone?: 'watch' | 'act';
  icon?: 'up' | 'down' | 'minus' | 'alert';
}

export interface HoldingRowView {
  key: string;
  symbol: string;
  sub: string;
  logos: readonly Logo[];
  amount: number | null;
  lpShare?: boolean;
  usd: number | null;
  status: Status;
}

export interface OtherChainGroup {
  key: string;
  label: string;
  items: readonly {
    key: string;
    symbol: string;
    sub: string;
    amount: number;
    usd: number | null;
    logos: readonly Logo[];
  }[];
  action: ReactNode;
}

// ponytail: mirrors the API's NEAR_RESERVE; send a flag from the API if the two ever diverge
const NEAR_FEE_RESERVE = 1;

const keptForFees = (h: HoldingInput) =>
  h.where === 'wallet' &&
  (h.token ?? h.symbol.toLowerCase()) === 'near' &&
  h.amount <= NEAR_FEE_RESERVE;

const TOKEN_KIND: Record<string, string> = {
  NEAR: 'Native token',
  WNEAR: 'Wrapped NEAR',
  STNEAR: 'Liquid staking',
  USDC: 'Stablecoin',
  'USDC.E': 'Bridged stablecoin',
  USDT: 'Stablecoin',
  'USDT.E': 'Bridged stablecoin',
};

const BURROW_SUB = { collateral: 'Collateral', deposited: 'Deposit', borrowed: 'Loan' } as const;

const GROUPS = [
  ['burrow', 'Burrow · lending'],
  ['liquidity', 'Liquidity'],
  ['orders', 'Limit orders'],
  ['staking', 'Staking'],
  ['wallet', 'Wallet'],
] as const;
type GroupKey = (typeof GROUPS)[number][0];

const rate = (pct: number) => `${pct.toFixed(pct < 1 ? 2 : 1)}%`;

const IDLE: Status = { label: 'Idle', tone: 'watch', icon: 'minus' };

function holdingStatus(h: HoldingInput): Status {
  const apr = h.aprPct ?? 0;
  if (h.where === 'borrowed')
    return { label: apr > 0 ? `Costs ${rate(apr)}` : 'Costs', tone: 'act', icon: 'down' };
  if (apr > 0) return { label: `Earning ${rate(apr)}`, icon: 'up' };
  if (h.where === 'collateral') return { label: 'Collateral' };
  if (h.where === 'deposited') return { label: 'Deposit' };
  return keptForFees(h) ? { label: 'Kept for fees' } : IDLE;
}

function positionStatus(p: PositionInput): [GroupKey, Status] {
  switch (p.kind) {
    case 'dcl':
      return [
        'liquidity',
        p.inRange === false
          ? { label: 'Out of range', tone: 'watch', icon: 'alert' }
          : { label: 'In range', icon: 'up' },
      ];
    case 'v1':
      return ['liquidity', { label: 'Earning fees', icon: 'up' }];
    case 'order':
      return ['orders', { label: 'Limit order' }];
    case 'unstaking':
      return ['staking', { label: 'Unstaking' }];
    case 'staking':
      return ['staking', { label: 'Staking', icon: 'up' }];
    default:
      return ['wallet', { label: 'Position' }];
  }
}

const suffix = (r: { estimate?: boolean; usd: number | null }) =>
  `${r.estimate ? ' · price estimate' : ''}${r.usd === null ? ' · no price' : ''}`;

export function holdingGroups(
  holdings: readonly HoldingInput[],
  positions: readonly PositionInput[],
) {
  type Entry = HoldingRowView & { group: GroupKey; verified: boolean; small: boolean };
  const all: Entry[] = [
    ...holdings.map((h): Entry => {
      return {
        key: `${h.where}-${h.token ?? h.symbol}`,
        group: h.where === 'wallet' ? 'wallet' : 'burrow',
        symbol: h.symbol,
        sub:
          (h.where === 'wallet'
            ? `${TOKEN_KIND[h.symbol.toUpperCase()] ?? 'Token'}${keptForFees(h) ? ' · gas' : ''}`
            : BURROW_SUB[h.where]) + suffix(h),
        logos: h.logos ?? [],
        amount: h.amount,
        usd: h.usd === null ? null : h.where === 'borrowed' ? -h.usd : h.usd,
        status: holdingStatus(h),
        verified: h.verified !== false,
        small: h.small ?? (h.usd !== null ? h.usd < 1 : h.amount < 0.005),
      };
    }),
    ...positions.map((p): Entry => {
      const [group, status] = positionStatus(p);
      return {
        key: p.key,
        group,
        symbol: p.label,
        sub: p.sub + suffix(p),
        logos: p.logos ?? [],
        amount: p.amount,
        lpShare: p.kind === 'v1' || p.kind === 'dcl',
        usd: p.usd,
        status,
        verified: p.verified !== false,
        small: p.small ?? (p.usd !== null && p.usd < 1),
      };
    }),
  ].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const shown = all.filter((r) => r.verified && !r.small);
  return {
    groups: GROUPS.map(([key, label]) => {
      const rows = shown.filter((r) => r.group === key);
      return { key, label, rows, totalUsd: rows.reduce((s, r) => s + (r.usd ?? 0), 0) };
    }).filter((g) => g.rows.length > 0),
    unverified: all.filter((r) => !r.verified && !r.small),
    small: all.filter((r) => r.small),
  };
}

const amountText = (n: number) =>
  n > 0 && n < 0.01
    ? n.toLocaleString('en-US', { maximumSignificantDigits: 2 })
    : n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 3 : 2 });

const STATUS_ICON = { up: TREND_UP, down: TREND_DOWN, minus: MINUS, alert: ALERT };

const usdText = (v: number | null) => money(v, v !== null && Math.abs(v) < 1000);

function Row({ r, status }: { r: Omit<HoldingRowView, 'status'>; status: ReactNode }) {
  return (
    <tr data-row={r.key}>
      <th scope="row">
        <div className="hold-asset">
          <TokenIcons tokens={r.logos} size={32} />
          <div>
            <b>{r.symbol}</b>
            <small>{r.sub}</small>
          </div>
        </div>
      </th>
      <td className="r num hold-amt">
        {r.amount !== null ? amountText(r.amount) : r.lpShare ? 'LP share' : '—'}
      </td>
      <td className="hold-status">{status}</td>
      <td className="r num hold-usd">
        <b>{usdText(r.usd)}</b>
      </td>
    </tr>
  );
}

const chip = (s: Status) => (
  <Chip tone={s.tone} icon={s.icon && STATUS_ICON[s.icon]}>
    {s.label}
  </Chip>
);

function Table({ caption, children }: { caption?: string; children: ReactNode }) {
  return (
    <table className="hold-t">
      {caption && <caption className="sr-only">{caption}</caption>}
      <thead>
        <tr>
          <th scope="col">Asset</th>
          <th scope="col" className="r">
            Amount
          </th>
          <th scope="col">Status</th>
          <th scope="col" className="r">
            Value
          </th>
        </tr>
      </thead>
      {children}
    </table>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function FootRows({ label, rows }: { label: string; rows: readonly HoldingRowView[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="hold-more">
      <summary>{label}</summary>
      <Table caption={label}>
        <tbody>
          {rows.map((r) => (
            <Row key={r.key} r={r} status={chip(r.status)} />
          ))}
        </tbody>
      </Table>
    </details>
  );
}

/** "What you hold": groups by where the money sits, a status per row, other chains and the empty wallet. */
export function HoldingsPanel({
  holdings,
  positions,
  provenance,
  source,
  other,
  flashScope,
  children,
}: {
  holdings: readonly HoldingInput[];
  positions: readonly PositionInput[];
  provenance: { kind: 'on_chain' | 'simulated'; age: string };
  source: string;
  other?: readonly OtherChainGroup[];
  /** Changed rows flash once after a refresh within this scope (an account); absent for a demo. */
  flashScope?: string;
  children?: ReactNode;
}) {
  const { groups, unverified, small } = holdingGroups(holdings, positions);
  const count = groups.reduce((n, g) => n + g.rows.length, 0) + unverified.length;
  const head = (
    <div className="hold-head">
      <h2 id="hold-h">What you hold</h2>
      {count > 0 && <span>{plural(count, 'position', 'positions')}</span>}
      <ProvenanceMark kind={provenance.kind} age={provenance.age} />
    </div>
  );
  if (groups.length + unverified.length + small.length === 0 && !other?.length)
    return (
      <section className="ds-panel hold" aria-labelledby="hold-h">
        {head}
        {children}
        <div className="hold-empty">
          <p>
            <b>This wallet holds nothing yet.</b> Once tokens arrive on NEAR they show here, grouped
            by where they sit, with what each one earns or costs.
          </p>
        </div>
      </section>
    );
  const shown = [...groups.flatMap((g) => g.rows), ...unverified, ...small];
  return (
    <section className="ds-panel hold" aria-labelledby="hold-h">
      {head}
      {children}
      <Table>
        {groups.map((g) => (
          <tbody key={g.key}>
            <tr className="hold-grp">
              <th scope="colgroup" colSpan={3}>
                {g.label}
              </th>
              <td className="r num">{usdText(g.totalUsd)}</td>
            </tr>
            {g.rows.map((r) => (
              <Row key={r.key} r={r} status={chip(r.status)} />
            ))}
          </tbody>
        ))}
        {other?.map((o) => (
          <tbody key={`other-${o.key}`} className="hold-ext">
            <tr className="hold-grp">
              <th scope="colgroup" colSpan={3}>
                {o.label} · shown only, not analysed
              </th>
              <td className="r num">{usdText(o.items.reduce((s, i) => s + (i.usd ?? 0), 0))}</td>
            </tr>
            {o.items.map((i) => (
              <Row key={i.key} r={i} status={o.action} />
            ))}
          </tbody>
        ))}
      </Table>
      <div className="hold-foot">
        <FootRows
          label={plural(unverified.length, 'unverified token', 'unverified tokens')}
          rows={unverified}
        />
        <FootRows
          label={plural(small.length, 'balance under $1', 'balances under $1')}
          rows={small}
        />
        <span className="hold-src">{source}</span>
      </div>
      {flashScope && (
        <RowFlash
          scope={flashScope}
          // ponytail: an LP row has no amount, so a price swing past 2 digits flashes it too
          rows={shown.map((r) => [
            r.key,
            r.amount === null ? (r.usd?.toPrecision(2) ?? '') : r.amount.toPrecision(4),
          ])}
        />
      )}
    </section>
  );
}
