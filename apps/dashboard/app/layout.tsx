import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'near-autopilot',
  description: 'Policy-gated autopilot for NEAR lending and swap positions',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            near-autopilot
          </Link>
          <nav aria-label="Primary">
            <Link href="/">Position</Link>
            <Link href="/activity">Activity</Link>
            <Link href="/policy">Policy</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
