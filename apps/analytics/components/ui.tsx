import Link from 'next/link';
import type { ReactNode } from 'react';
import { statusOf } from '../lib/format';
import { Chip } from './primitives';
import { ErrorState } from './states';

export function PageHeader(p: {
  title: ReactNode;
  lead?: ReactNode;
  meta?: ReactNode;
  crumbs?: readonly { href: string; label: string }[];
}) {
  return (
    <header className="page-head">
      <div>
        {p.crumbs && (
          <div className="crumbs">
            {p.crumbs.map((c, i) => (
              <span key={c.href}>
                {i > 0 && ' / '}
                <Link href={c.href}>{c.label}</Link>
              </span>
            ))}
          </div>
        )}
        <h1>{p.title}</h1>
        {p.lead && <p>{p.lead}</p>}
      </div>
      {p.meta && <div className="meta">{p.meta}</div>}
    </header>
  );
}

export function Section(p: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{p.title}</h2>
        {p.aside}
      </div>
      {p.note && (
        <p className="note" style={{ margin: '0 0 10px' }}>
          {p.note}
        </p>
      )}
      {p.children}
    </section>
  );
}

const ICON = { good: '✓', warning: '!', serious: '!', critical: '×', neutral: '•' } as const;

const TONE = {
  good: 'safe',
  warning: 'watch',
  serious: 'act',
  critical: 'liq',
  neutral: undefined,
} as const;

const glyph = (kind: keyof typeof ICON) => <i aria-hidden="true">{ICON[kind]}</i>;

/** A state with an icon and a label (never colour alone). The raw code is in the tooltip. */
export function Status({ code, label }: { code: string | null | undefined; label?: string }) {
  const s = statusOf(code);
  return (
    <Chip tone={TONE[s.kind]} icon={glyph(s.kind)} tip={code ?? 'unknown'}>
      {label ?? s.label}
    </Chip>
  );
}

/** A failed API read: which data, the reason, and a retry. */
export function ApiError({ what, error }: { what: string; error: string | null }) {
  return <ErrorState what={what} error={error} />;
}

/** Nothing to show, and why: an empty list is explained, never a blank area or a 0. */
export function EmptyState(p: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state empty-state">
      <div className="state-icon" aria-hidden="true">
        ○
      </div>
      <div>
        <b>{p.title}</b>
        {p.children && <p>{p.children}</p>}
        {p.action && <div style={{ marginTop: 10 }}>{p.action}</div>}
      </div>
    </div>
  );
}

/** A labelled list of facts (definition list), two columns on wide screens. */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="facts">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const LEVEL_KIND = { low: 'good', medium: 'warning', high: 'critical' } as const;

/** Risk or confidence as a word with an icon, the score in the tooltip. */
export function Level({
  level,
  score,
  what,
  invert = false,
}: {
  level: 'low' | 'medium' | 'high';
  score: number;
  what: 'risk' | 'confidence';
  invert?: boolean;
}) {
  const kind = invert
    ? LEVEL_KIND[level === 'low' ? 'high' : level === 'high' ? 'low' : 'medium']
    : LEVEL_KIND[level];
  return (
    <Chip tone={TONE[kind]} icon={glyph(kind)} tip={`${what} score ${score} / 100`}>
      {level[0]?.toUpperCase()}
      {level.slice(1)} {what}
    </Chip>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}
