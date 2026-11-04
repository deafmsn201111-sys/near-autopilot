import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ProvenanceBanner } from '../components/ProvenanceBanner';
import { getPolicy } from '../lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: 'near-autopilot',
  description: 'Policy-gated autopilot for NEAR lending and swap positions',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The banner must render even when the API is down (error pages still need the layout).
  const policy = await getPolicy().catch(() => null);
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            near-autopilot
          </Link>
          <nav aria-label="Primary">
            <Link href="/">Position</Link>
            <Link href="/market">Market data</Link>
            <Link href="/yield">Yield data</Link>
            <Link href="/activity">Activity</Link>
            <Link href="/policy">Policy</Link>
          </nav>
        </header>
        <ProvenanceBanner policy={policy} />
        <main>{children}</main>
      </body>
    </html>
  );
}
