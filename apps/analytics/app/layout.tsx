import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import './globals.css';

export const metadata: Metadata = {
  title: 'near-autopilot analytics (shadow)',
  description: 'Mainnet read-only analytics: Rhea, Burrow, prices, LP simulation, demo portfolios',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shadow-banner" role="status">
          SHADOW MODE — MAINNET READ-ONLY — NO TRANSACTIONS
        </div>
        <header className="top">
          <Link href="/" className="brand">
            near-autopilot analytics
          </Link>
          <nav aria-label="Primary">
            <Link href="/">Overview</Link>
            <Link href="/rhea">Rhea</Link>
            <Link href="/burrow">Burrow</Link>
            <Link href="/prices">Prices</Link>
            <Link href="/lp">LP</Link>
            <Link href="/portfolios">Portfolios</Link>
            <Link href="/strategies">Strategies</Link>
            <Link href="/collector">Collector</Link>
          </nav>
        </header>
        <AutoRefresh seconds={20} />
        <main>{children}</main>
      </body>
    </html>
  );
}
