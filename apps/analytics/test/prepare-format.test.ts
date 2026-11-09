import { describe, expect, it } from 'vitest';
import { gasToTgas, shortAccount, totalDepositNear, yoctoToNear } from '../lib/prepare-format';

describe('yoctoToNear', () => {
  it('formats common deposits without scientific notation', () => {
    expect(yoctoToNear('1')).toBe('0.000000000000000000000001');
    expect(yoctoToNear('100000000000000000000000')).toBe('0.1'); // Burrow registration
    expect(yoctoToNear('1020000000000000000000')).toBe('0.00102'); // exchange registration
    expect(yoctoToNear('10000000000000000000000')).toBe('0.01'); // add_liquidity buffer
    expect(yoctoToNear('1000000000000000000000000')).toBe('1');
    expect(yoctoToNear('0')).toBe('0');
  });
  it('is defensive about non-numeric input', () => {
    expect(yoctoToNear('abc')).toBe('0');
  });
});

describe('gasToTgas', () => {
  it('converts gas units to Tgas', () => {
    expect(gasToTgas('150000000000000')).toBe('150 Tgas');
    expect(gasToTgas('10000000000000')).toBe('10 Tgas');
    expect(gasToTgas('30000000000000')).toBe('30 Tgas');
  });
});

describe('shortAccount', () => {
  it('keeps short ids and shortens long/hex ones', () => {
    expect(shortAccount('root.near')).toBe('root.near');
    expect(shortAccount('v2.ref-finance.near')).toBe('v2.ref-finance.near');
    const hex = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    expect(shortAccount(hex)).toBe('17208628f8…e36133a1'); // first 10 … last 8
  });
});

describe('totalDepositNear', () => {
  it('sums deposits across all actions', () => {
    const txs = [
      { actions: [{ deposit: '100000000000000000000000' }] }, // 0.1
      { actions: [{ deposit: '1' }, { deposit: '10000000000000000000000' }] }, // ~0.01
    ];
    expect(totalDepositNear(txs)).toBe('0.110000000000000000000001');
  });
});
