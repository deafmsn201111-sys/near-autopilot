import Link from 'next/link';

export const PORTFOLIOS = [
  { id: 'demo-5000', label: '$5,000 portfolio' },
  { id: 'demo-500', label: '$500 portfolio' },
] as const;
export type PortfolioId = (typeof PORTFOLIOS)[number]['id'];
export const portfolioOf = (v: string | string[] | undefined): PortfolioId =>
  v === 'demo-500' ? 'demo-500' : 'demo-5000';

export function PortfolioSwitch({ current, path }: { current: PortfolioId; path: string }) {
  return (
    <nav className="segmented" aria-label="Demo portfolio">
      {PORTFOLIOS.map((p) => (
        <Link
          key={p.id}
          href={`${path}?p=${p.id}`}
          aria-current={p.id === current ? 'true' : undefined}
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
