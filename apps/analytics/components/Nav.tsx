'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Four product sections for a person who wants to use the autopilot. Everything technical (policy checks, audit
 * chains, routes, sources, collector, raw markets) lives under one "For reviewers" area, out of the main navigation.
 */
export const MAIN = [
  { href: '/', label: 'Portfolio', match: ['/'] },
  { href: '/opportunities', label: 'Opportunities', match: ['/opportunities'] },
  { href: '/activity', label: 'Activity', match: ['/activity'] },
  { href: '/research', label: 'Research', match: ['/research'] },
] as const;

export const REVIEWER_TABS = [
  { href: '/reviewers', label: 'Start here' },
  { href: '/policy', label: 'Safety policy' },
  { href: '/audit', label: 'Audit trail' },
  { href: '/routes', label: 'Execution routes' },
  { href: '/autopilot', label: 'Controls' },
  { href: '/system', label: 'System health' },
  { href: '/rhea', label: 'Rhea pools' },
  { href: '/burrow', label: 'Burrow markets' },
  { href: '/prices', label: 'Prices' },
  { href: '/portfolios', label: 'Portfolio risk' },
  { href: '/strategies', label: 'Strategies' },
  { href: '/lp', label: 'LP simulation' },
  { href: '/thesis', label: 'Thesis data' },
  { href: '/collector', label: 'Collector' },
] as const;

export const isIn = (path: string, match: readonly string[]) =>
  match.some((m) => (m === '/' ? path === '/' : path === m || path.startsWith(`${m}/`)));

const inReviewers = (path: string) =>
  isIn(
    path,
    REVIEWER_TABS.map((t) => t.href),
  );

export function TopNav() {
  const path = usePathname();
  return (
    <nav className="topnav" aria-label="Main">
      {MAIN.map((s) => (
        <Link key={s.href} href={s.href} aria-current={isIn(path, s.match) ? 'page' : undefined}>
          {s.label}
        </Link>
      ))}
      <Link
        href="/reviewers"
        className="reviewers-link"
        aria-current={inReviewers(path) ? 'page' : undefined}
      >
        For reviewers
      </Link>
    </nav>
  );
}

/** Tabs across the technical pages, only inside the reviewers area. */
export function SubNav() {
  const path = usePathname();
  if (!inReviewers(path)) return null;
  return (
    <nav className="tabs" aria-label="Technical pages">
      {REVIEWER_TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          className="tab"
          aria-current={isIn(path, [t.href]) ? 'page' : undefined}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
