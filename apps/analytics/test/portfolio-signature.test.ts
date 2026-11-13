import { describe, expect, it } from 'vitest';
import { portfolioSignature } from '../lib/portfolio-signature';

const loan = { id: 'improve-loan-safety', title: "Your loan's health factor is 1.21" };
const idle = { id: 'put-idle-to-work', title: '$120 of USDC is sitting idle' };
const holdings = [
  { where: 'collateral' as const, symbol: 'NEAR', amount: 100, usd: 300 },
  { where: 'borrowed' as const, symbol: 'USDC', amount: 150, usd: 150 },
];

describe('portfolioSignature', () => {
  const base = portfolioSignature([loan, idle], holdings);

  it('ignores price moves: new numbers in titles and usd values', () => {
    const cards = [
      { ...idle, title: '$118 of USDC is sitting idle' },
      { ...loan, title: "Your loan's health factor is 1.19" },
    ];
    const repriced = portfolioSignature(
      cards,
      holdings.map((h) => ({ ...h, usd: (h.usd ?? 0) * 1.03 })),
    );
    expect(repriced).toBe(base);
  });

  it('ignores interest accruing on a loan', () => {
    const accrued = holdings.map((h) => (h.where === 'borrowed' ? { ...h, amount: 150.0004 } : h));
    expect(portfolioSignature([loan, idle], accrued)).toBe(base);
  });

  it('changes when a card appears or disappears', () => {
    expect(portfolioSignature([loan], holdings)).not.toBe(base);
  });

  it('changes when holdings change though the cards stay (part of the loan repaid)', () => {
    const repaid = holdings.map((h) => (h.where === 'borrowed' ? { ...h, amount: 100 } : h));
    expect(portfolioSignature([loan, idle], repaid)).not.toBe(base);
  });
});
