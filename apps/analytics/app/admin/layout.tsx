import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { adminEnabled } from '../../lib/admin';

export const dynamic = 'force-dynamic';

export default function AdminLayout({ children }: { children: ReactNode }) {
  if (!adminEnabled()) notFound();
  return children;
}
