import type { PortfolioSnapshot, TokenId } from '@near-autopilot/core';

/** Which tracked tokens the snapshot could price. Missing prices are listed, never treated as zero. */
export function pricingOf(snapshot: PortfolioSnapshot): {
  readonly priced: string[];
  readonly unpriced: string[];
} {
  const tracked = new Set<TokenId>([
    ...snapshot.tokens.keys(),
    ...snapshot.walletBalances.map((b) => b.token),
    ...(snapshot.lending
      ? [...snapshot.lending.supplied, ...snapshot.lending.collateral, ...snapshot.lending.borrowed]
      : []
    ).map((b) => b.token),
  ]);
  const priced: string[] = [];
  const unpriced: string[] = [];
  for (const token of [...tracked].sort()) {
    (snapshot.prices.has(token) ? priced : unpriced).push(token);
  }
  return { priced, unpriced };
}

/** One line on the data a cycle decided from, for the run record (shown in the dashboard). */
export function describeSnapshot(snapshot: PortfolioSnapshot): string {
  const { priced, unpriced } = pricingOf(snapshot);
  const total = priced.length + unpriced.length;
  const prices =
    unpriced.length === 0
      ? `prices: ${priced.length}/${total} tracked tokens priced`
      : `prices: ${priced.length}/${total} tracked tokens priced (no price: ${unpriced.join(', ')})`;
  const l = snapshot.lending;
  const position =
    l && l.supplied.length + l.collateral.length + l.borrowed.length > 0
      ? `Burrow position: ${l.collateral.length} collateral, ${l.supplied.length} supplied, ${l.borrowed.length} borrowed`
      : 'Burrow position: none';
  return `${prices}; ${position}`;
}
