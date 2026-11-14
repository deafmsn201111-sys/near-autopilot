'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icons';

export const MAIN = [
  { href: '/', label: 'Portfolio', icon: 'pie' },
  { href: '/opportunities', label: 'Opportunities', icon: 'compass' },
  { href: '/activity', label: 'Activity', icon: 'list' },
] as const satisfies readonly { href: string; label: string; icon: IconName }[];

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

const current = (path: string, href: string) => (isIn(path, [href]) ? 'page' : undefined);

export function TopNav() {
  const path = usePathname();
  return (
    <nav className="app-nav" aria-label="Main">
      {MAIN.map((s) => (
        <Link key={s.href} href={s.href} aria-current={current(path, s.href)}>
          {s.label}
        </Link>
      ))}
      <Link
        href="/reviewers"
        className="app-nav-reviewers"
        aria-current={inReviewers(path) ? 'page' : undefined}
      >
        For reviewers
      </Link>
    </nav>
  );
}

export function TabBar() {
  const path = usePathname();
  return (
    <nav className="app-tabs" aria-label="Sections">
      {MAIN.map((s) => (
        <Link key={s.href} href={s.href} aria-current={current(path, s.href)}>
          <Icon name={s.icon} size={20} />
          {s.label}
        </Link>
      ))}
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
