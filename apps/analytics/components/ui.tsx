import Link from 'next/link';
import type { ReactNode } from 'react';
import { statusOf } from '../lib/format';

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

export function Tile(p: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  hero?: boolean;
  href?: string;
}) {
  const body = (
    <div className={`card tile${p.hero ? ' hero' : ''}`}>
      <div className="label">{p.label}</div>
      <div className="value">{p.value}</div>
      {p.sub && <div className="sub">{p.sub}</div>}
    </div>
  );
  return p.href ? (
    <Link href={p.href} style={{ textDecoration: 'none' }}>
      {body}
    </Link>
  ) : (
    body
  );
}

const ICON = { good: '✓', warning: '!', serious: '!', critical: '×', neutral: '•' } as const;

/** A state with an icon and a label (never colour alone). The raw code is in the tooltip. */
export function Status({ code, label }: { code: string | null | undefined; label?: string }) {
  const s = statusOf(code);
  return (
    <span className={`badge ${s.kind}`} data-tip={code ?? 'unknown'} tabIndex={0}>
      <i aria-hidden="true">{ICON[s.kind]}</i>
      {label ?? s.label}
    </span>
  );
}

/** A fraction as a meter on a same-ramp track, with the value beside it. */
export function Meter({ value, high = 0.9 }: { value: number | null; high?: number }) {
  if (value === null || !Number.isFinite(value)) return <span className="dim">—</span>;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={`meter${value >= high ? ' high' : ''}`}>
      <span className="track" aria-hidden="true">
        <span className="fill" style={{ width: `${(v * 100).toFixed(1)}%`, display: 'block' }} />
      </span>
      {(value * 100).toFixed(1)}%
    </span>
  );
}

export function ApiError({ what, error }: { what: string; error: string | null }) {
  return (
    <div className="error">
      <b>{what} unavailable.</b> <span className="dim">{error}</span>
    </div>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>;
}
