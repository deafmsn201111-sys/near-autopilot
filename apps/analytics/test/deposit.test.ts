import { describe, expect, it } from 'vitest';
import { defaultDestination, formatUnits } from '../lib/deposit';

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
