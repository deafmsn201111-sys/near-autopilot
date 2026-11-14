export const PORTFOLIOS = [
  { id: 'demo-5000', label: '$5,000 demo' },
  { id: 'demo-500', label: '$500 demo' },
] as const;
export type PortfolioId = (typeof PORTFOLIOS)[number]['id'];
export const portfolioOf = (v: string | string[] | undefined): PortfolioId =>
  v === 'demo-500' ? 'demo-500' : 'demo-5000';
