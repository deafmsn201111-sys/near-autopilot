import { describe, expect, it } from 'vitest';
import { defaultDestination, defaultOrigin, formatUnits, searchTokens } from '../lib/deposit';

describe('formatUnits', () => {
  it('formats base units exactly', () => {
    expect(formatUnits('1500000', 6)).toBe('1.5');
    expect(formatUnits('100000000', 6)).toBe('100');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('1234567890123456789012345', 24)).toBe('1.234567890123456789012345');
    expect(formatUnits('5', 0)).toBe('5');
  });
});

describe('defaultDestination', () => {
  const wnear = { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 };
  const usdc = { assetId: 'nep141:usdc', symbol: 'USDC', decimals: 6 };
  const usdt = { assetId: 'nep141:usdt', symbol: 'USDT', decimals: 6 };
  const from = (symbol: string) => ({
    assetId: symbol,
    symbol,
    decimals: 6,
    chain: 'eth',
    chainName: 'Ethereum',
  });

  it('takes the same symbol, else USDC, else the first', () => {
    expect(defaultDestination(from('USDT'), [wnear, usdc, usdt])).toBe(usdt);
    expect(defaultDestination(from('ETH'), [wnear, usdc, usdt])).toBe(usdc);
    expect(defaultDestination(from('ETH'), [wnear])).toBe(wnear);
    expect(defaultDestination(undefined, [])).toBeUndefined();
  });
});

describe('defaultOrigin', () => {
  const t = (symbol: string, chain: string) => ({
    assetId: `${chain}:${symbol}`,
    symbol,
    decimals: 6,
    chain,
    chainName: chain,
  });
  const origins = [
    t('USDC', 'eth'),
    t('ETH', 'eth'),
    t('ETH', 'arb'),
    t('BTC', 'btc'),
    t('PEPE', 'sol'),
  ];

  it('takes USDC on the chain, else its native token, else the first there', () => {
    expect(defaultOrigin(origins, 'eth')?.assetId).toBe('eth:USDC');
    expect(defaultOrigin(origins, 'arb')?.assetId).toBe('arb:ETH');
    expect(defaultOrigin(origins, 'btc')?.assetId).toBe('btc:BTC');
    expect(defaultOrigin(origins, 'sol')?.assetId).toBe('sol:PEPE');
    expect(defaultOrigin(origins, 'base')).toBeUndefined();
  });
});

describe('searchTokens', () => {
  const list = ['USDT', 'USDC', 'ETH', 'steakUSDC', 'WETH'].map((symbol) => ({
    assetId: symbol,
    symbol,
    decimals: 6,
  }));

  it('matches the symbol case-insensitively, symbols starting with the query first', () => {
    expect(searchTokens(list, 'usd').map((x) => x.symbol)).toEqual(['USDT', 'USDC', 'steakUSDC']);
    expect(searchTokens(list, ' eth ').map((x) => x.symbol)).toEqual(['ETH', 'WETH']);
  });

  it('keeps the whole list for an empty query', () => {
    expect(searchTokens(list, '')).toEqual(list);
  });
});
