'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Minimal line icons (no icon library): 18px, stroke = currentColor, so they follow the theme. */
const Icon = ({ d }: { d: ReactNode }) => (
  <svg
    className="nav-ico"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);
const ICONS = {
  portfolio: <Icon d={<path d="M3 13h4l2 5 4-12 2 7h6" />} />,
  opportunities: (
    <Icon
      d={
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      }
    />
  ),
  activity: (
    <Icon
      d={
        <>
          <path d="M4 6h16M4 12h16M4 18h10" />
        </>
      }
    />
  ),
  research: (
    <Icon
      d={
        <>
          <path d="M4 19V5l8 4 8-4v14l-8 4z" />
          <path d="M12 9v14" />
        </>
      }
    />
  ),
  reviewers: (
    <Icon
      d={
        <>
          <path d="m9 12 2 2 4-4" />
          <path d="M12 3 4 6v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6z" />
        </>
      }
    />
  ),
} as const;

/**
 * Four product sections for a person who wants to use the autopilot. Everything technical (policy checks, audit
 * chains, routes, sources, collector, raw markets) lives under one "For reviewers" area, out of the main navigation.
 */
export const MAIN = [
  { href: '/', label: 'Portfolio', match: ['/'], icon: ICONS.portfolio },
  {
    href: '/opportunities',
    label: 'Opportunities',
    match: ['/opportunities'],
    icon: ICONS.opportunities,
  },
  { href: '/activity', label: 'Activity', match: ['/activity'], icon: ICONS.activity },
] as const;

export const REVIEWER_TABS = [
  { href: '/reviewers', label: 'Start here' },
  { href: '/research', label: 'Research' },
  { href: '/policy', label: 'Safety policy' },
  { href: '/audit', label: 'Audit trail' },
  { href: '/routes', label: 'Execution routes' },
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
          {s.icon}
          <span className="nav-label">{s.label}</span>
        </Link>
      ))}
      <Link
        href="/reviewers"
        className="reviewers-link"
        aria-current={inReviewers(path) ? 'page' : undefined}
      >
        {ICONS.reviewers}
        <span className="nav-label">For reviewers</span>
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
