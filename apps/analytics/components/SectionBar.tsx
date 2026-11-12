'use client';
import { usePathname } from 'next/navigation';

const sections: readonly [string, string][] = [
  ['/opportunities', '02 / Opportunities'],
  ['/activity', '03 / Activity'],
  ['/reviewers', '04 / Reviewer tools'],
  ['/research', '04 / Reviewer tools'],
  ['/policy', '04 / Reviewer tools'],
  ['/audit', '04 / Reviewer tools'],
  ['/routes', '04 / Reviewer tools'],
  ['/system', '04 / Reviewer tools'],
  ['/rhea', '04 / Reviewer tools'],
  ['/burrow', '04 / Reviewer tools'],
  ['/prices', '04 / Reviewer tools'],
  ['/portfolios', '04 / Reviewer tools'],
  ['/strategies', '04 / Reviewer tools'],
  ['/lp', '04 / Reviewer tools'],
  ['/thesis', '04 / Reviewer tools'],
  ['/collector', '04 / Reviewer tools'],
];

export function SectionBar() {
  const path = usePathname();
  const section = sections.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return <span className="terminal-section">{section?.[1] ?? '01 / Portfolio'}</span>;
}
