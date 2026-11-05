import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import { Nav } from '../components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEAR Autopilot · analytics',
  description: 'Mainnet read-only analytics: Rhea, Burrow, prices, LP simulation, demo portfolios',
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
              <span>analytics</span>
            </Link>
            <div className="env" role="status">
              <b>
                <span className="badge warning" aria-hidden="true">
                  <i>!</i>
                </span>
                Shadow mode
              </b>
              <span>Mainnet read-only. No signer, no transactions.</span>
            </div>
            <Nav />
            <div className="sidebar-foot">
              Stored data only: opening a page never collects anything. Refreshes every 20 s.
            </div>
          </aside>
          <main>{children}</main>
        </div>
        <AutoRefresh seconds={20} />
      </body>
    </html>
  );
}
