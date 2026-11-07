'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Seven sections, in the order of the main user journey: understand the state -> find an opportunity -> manage the
 * autopilot -> see the simulated portfolios -> research -> what happened -> diagnostics. Detailed pages live as tabs
 * inside their section (see SECTIONS); their old URLs keep working.
 */
export const SECTIONS = [
  { href: '/', label: 'Overview', icon: '◎', match: ['/'] },
  { href: '/opportunities', label: 'Opportunities', icon: '◆', match: ['/opportunities'] },
  { href: '/autopilot', label: 'Autopilot', icon: '▶', match: ['/autopilot'] },
  {
    href: '/portfolios',
    label: 'Portfolio & Simulation',
    icon: '▦',
    match: ['/portfolios', '/strategies', '/lp'],
    tabs: [
      { href: '/portfolios', label: 'Demo portfolios' },
      { href: '/strategies', label: 'Strategy comparison' },
      { href: '/lp', label: 'LP simulation' },
    ],
  },
  {
    href: '/rhea',
    label: 'Analytics & Thesis',
    icon: '◔',
    match: ['/rhea', '/burrow', '/prices', '/thesis'],
    tabs: [
      { href: '/rhea', label: 'Rhea pools' },
      { href: '/burrow', label: 'Burrow markets' },
      { href: '/prices', label: 'Prices' },
      { href: '/thesis', label: 'Investment thesis' },
    ],
  },
  {
    href: '/activity',
    label: 'Activity & Audit',
    icon: '≡',
    match: ['/activity', '/policy', '/routes', '/audit'],
    tabs: [
      { href: '/activity', label: 'Activity' },
      { href: '/policy', label: 'Policy decisions' },
      { href: '/routes', label: 'Execution routes' },
      { href: '/audit', label: 'Audit trail' },
    ],
  },
  {
    href: '/system',
    label: 'System Health',
    icon: '♥',
    match: ['/system', '/collector'],
    tabs: [
      { href: '/system', label: 'Health' },
      { href: '/collector', label: 'Collector log' },
    ],
  },
] as const;

export const isIn = (path: string, match: readonly string[]) =>
  match.some((m) => (m === '/' ? path === '/' : path === m || path.startsWith(`${m}/`)));

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Sections">
      {SECTIONS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          className="nav-link"
          aria-current={isIn(path, s.match) ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">
            {s.icon}
          </span>
          {s.label}
        </Link>
      ))}
    </nav>
  );
}

/** The tabs of the current section (only for sections that have several pages). */
export function SubNav() {
  const path = usePathname();
  const section = SECTIONS.find((s) => isIn(path, s.match));
  if (!section || !('tabs' in section)) return null;
  return (
    <nav className="tabs" aria-label={`${section.label} pages`}>
      {section.tabs.map((t) => (
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
