import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import { SubNav, TopNav } from '../components/Nav';
import { WalletButton } from '../components/WalletButton';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEAR Autopilot',
  description:
    'An autopilot for your NEAR DeFi portfolio: it watches Burrow and Rhea, finds what is worth doing, and explains every decision.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="logo">
              <span className="logo-mark" aria-hidden="true">
                ◆
              </span>
              NEAR Autopilot
            </Link>
            <TopNav />
            <WalletButton />
            <span
              className="mode-pill"
              data-tip={
                'Shadow mode: real mainnet prices, simulated portfolios.\nNo wallet is connected and nothing is ever sent.'
              }
              tabIndex={0}
            >
              Shadow mode
            </span>
          </div>
        </header>
        <main className="page">
          <SubNav />
          {children}
        </main>
        <AutoRefresh seconds={30} />
      </body>
    </html>
  );
}
