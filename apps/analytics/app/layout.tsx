import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import { FreshnessNote } from '../components/FreshnessNote';
import { Nav, SubNav } from '../components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEAR Autopilot · analytics',
  description:
    'NEAR Autopilot: DeFi opportunities on Rhea and Burrow, checked by an independent policy engine. Mainnet read-only.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <Link href="/" className="brand">
              <b>NEAR Autopilot</b>
              <span>DeFi autopilot for NEAR</span>
            </Link>
            <div className="env" role="status">
              <b>
                <span className="badge warning" aria-hidden="true">
                  <i>!</i>
                </span>
                Shadow mode
              </b>
              <span>Reads NEAR mainnet only. No wallet, no signing, no transactions.</span>
            </div>
            <FreshnessNote />
            <Nav />
            <div className="sidebar-foot">
              Pages show stored data and re-read it every 20 s. Opening a page never collects or
              sends anything.
            </div>
          </aside>
          <main>
            <SubNav />
            {children}
          </main>
        </div>
        <AutoRefresh seconds={20} />
      </body>
    </html>
  );
}
