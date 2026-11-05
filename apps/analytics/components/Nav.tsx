'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const NAV: readonly { group: string; links: readonly { href: string; label: string }[] }[] =
  [
    {
      group: 'Market',
      links: [
        { href: '/', label: 'Overview' },
        { href: '/rhea', label: 'Rhea pools' },
        { href: '/burrow', label: 'Burrow markets' },
        { href: '/prices', label: 'Prices' },
      ],
    },
    {
      group: 'Autopilot',
      links: [
        { href: '/portfolios', label: 'Portfolios' },
        { href: '/strategies', label: 'Strategies' },
        { href: '/lp', label: 'LP simulation' },
      ],
    },
    { group: 'System', links: [{ href: '/collector', label: 'Collector' }] },
  ];

export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <>
      {NAV.map((g) => (
        <nav className="nav-group" key={g.group} aria-label={g.group}>
          <span>{g.group}</span>
          {g.links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="nav-link"
              aria-current={active(l.href) ? 'page' : undefined}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      ))}
    </>
  );
}
