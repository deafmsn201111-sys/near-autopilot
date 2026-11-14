import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { adminEnabled } from '../../lib/admin';

export const dynamic = 'force-dynamic';

const SCREENS = [
  { href: '/admin', label: 'Spend & controls' },
  { href: '/admin/funnel', label: 'Funnel' },
  { href: '/admin/llm', label: 'LLM quality' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  if (!adminEnabled()) notFound();
  return (
    <>
      <nav className="crumbs" aria-label="Admin screens">
        {SCREENS.map((s, i) => (
          <span key={s.href}>
            {i > 0 && ' · '}
            <Link href={s.href}>{s.label}</Link>
          </span>
        ))}
      </nav>
      {children}
    </>
  );
}
