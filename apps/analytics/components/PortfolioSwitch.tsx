import Link from 'next/link';

export const PORTFOLIOS = [
  { id: 'demo-5000', label: '$5,000 demo' },
  { id: 'demo-500', label: '$500 demo' },
] as const;
export type PortfolioId = (typeof PORTFOLIOS)[number]['id'];
export const portfolioOf = (v: string | string[] | undefined): PortfolioId =>
  v === 'demo-500' ? 'demo-500' : 'demo-5000';

/** Demo portfolios, and (on the Portfolio page) "Your account": any NEAR mainnet account, read-only. */
export function PortfolioSwitch({
  current,
  path,
  withAccount = false,
  account = '',
}: {
  current: PortfolioId | 'account';
  path: string;
  withAccount?: boolean;
  /** The connected account id, so the "Your account" tab keeps working after navigating away. */
  account?: string;
}) {
  return (
    <nav className="segmented" aria-label="Portfolio">
      {PORTFOLIOS.map((p) => (
        <Link
          key={p.id}
          href={`${path}?p=${p.id}`}
          aria-current={p.id === current ? 'true' : undefined}
        >
          {p.label}
        </Link>
      ))}
      {withAccount && (
        <Link
          href={`${path}?p=account${account ? `&account=${encodeURIComponent(account)}` : ''}`}
          aria-current={current === 'account' ? 'true' : undefined}
        >
          Your account
          {current === 'account' && <span className="seg-live">LIVE</span>}
        </Link>
      )}
    </nav>
  );
}
