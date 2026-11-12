import type { PortfolioView } from './product';

type Holding = Pick<PortfolioView['holdings'][number], 'where' | 'symbol' | 'amount'>;

/**
 * What the AI ranking was computed for: which cards exist and what the account holds. Prices are left out on purpose,
 * so the result survives auto-refreshes and is dropped only when the portfolio itself changes.
 */
export const portfolioSignature = (
  cards: readonly { id: string }[],
  holdings: readonly Holding[],
): string => {
  const ids = cards.map((c) => c.id).sort();
  // ponytail: 3 significant digits hide loan interest accrual; a rare rounding-boundary crossing drops the result once
  const amounts = holdings.map((h) => `${h.where}:${h.symbol}:${h.amount.toPrecision(3)}`).sort();
  return [...ids, ...amounts].join('|');
};
