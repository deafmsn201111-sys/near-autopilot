import { PUBLIC_DEMO } from '../lib/public-demo';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AutoRefresh } from '../components/AutoRefresh';
import { SubNav, TopNav } from '../components/Nav';
import { ThemeToggle } from '../components/ThemeToggle';
import { WalletButton } from '../components/WalletButton';
import './globals.css';

/** Applies the saved theme before first paint, so there is no flash of the wrong theme. Dark is the default
 *  identity (the "Signal Terminal" direction); only an explicit saved choice overrides it. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('theme');if(t!=='dark'&&t!=='light'){t='dark';}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export const metadata: Metadata = {
  title: 'NEAR Autopilot',
  description:
    'An autopilot for your NEAR DeFi portfolio: it watches Burrow and Rhea, finds what is worth doing, and explains every decision.',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="logo">
              <span className="logo-mark" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M6 18V6l12 12V6"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              NEAR Autopilot
            </Link>
            <TopNav />
            <ThemeToggle />
            <WalletButton />
          </div>
        </header>
        <main className="page">
          {PUBLIC_DEMO && (
            <div className="callout" role="note" style={{ marginBottom: 16 }}>
              <b>Public demo.</b> Live NEAR mainnet data, read only. The demo portfolios are
              simulated and shared by every visitor; what you ask the agent to do runs as a dry run
              and is never signed or sent. Operator controls are disabled here: run the project
              locally to use them.
            </div>
          )}
          <SubNav />
          {children}
        </main>
        <AutoRefresh seconds={15} />
      </body>
    </html>
  );
}
