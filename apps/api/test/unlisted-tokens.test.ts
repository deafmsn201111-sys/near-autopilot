import { describe, expect, it } from 'vitest';
import { unlistedByValue } from '../src/analytics/account-view';

describe('unlistedByValue (#192)', () => {
  const usd = new Map([
    ['dust.near', 0.000001],
    ['imeme.near', 0.000419],
    ['nodecimals.near', 5],
  ]);
  const decimals = new Map([
    ['dust.near', 18],
    ['imeme.near', 18],
  ]);

  it('puts the most valuable priced token first, whatever order the indexer gave', () => {
    const tokens = [
      ...Array.from({ length: 40 }, (_, i) => ({ token: `spam${i}.near`, raw: 10n ** 30n })),
      { token: 'dust.near', raw: 10n ** 18n },
      { token: 'imeme.near', raw: 220_195n * 10n ** 18n },
    ];
    const ranked = unlistedByValue(tokens, usd, decimals).slice(0, 30);
    expect(ranked[0]?.token).toBe('imeme.near');
    expect(ranked[1]?.token).toBe('dust.near');
  });

  it('keeps a priced token without known decimals ahead of unpriced ones, behind valued ones', () => {
    const ranked = unlistedByValue(
      [
        { token: 'spam.near', raw: 1n },
        { token: 'nodecimals.near', raw: 1n },
        { token: 'imeme.near', raw: 10n ** 18n },
      ],
      usd,
      decimals,
    );
    expect(ranked.map((t) => t.token)).toEqual(['imeme.near', 'nodecimals.near', 'spam.near']);
  });
});
