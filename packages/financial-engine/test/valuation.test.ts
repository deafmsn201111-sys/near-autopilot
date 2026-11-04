import { describe, expect, it } from 'vitest';
import { MissingPriceError, accountId } from '@near-autopilot/core';
import { rawForValueUsd, sumValueUsd, tokenValueUsd, valueUsd } from '../src';
import { NEAR_PRICE, USDT_PRICE, WNEAR, near, prices, usdt } from './fixtures';

describe('valuation', () => {
  it('values raw token units in micro-USD', () => {
    expect(valueUsd(near(2), NEAR_PRICE)).toBe(10_000_000n); // 2 NEAR @ $5
    expect(valueUsd(usdt(42), USDT_PRICE)).toBe(42_000_000n);
  });

  it('rawForValueUsd rounds up and never under-covers', () => {
    const raw = rawForValueUsd(10_000_000n, NEAR_PRICE);
    expect(raw).toBe(near(2));
    const odd = rawForValueUsd(1n, USDT_PRICE);
    expect(valueUsd(odd, USDT_PRICE)).toBeGreaterThanOrEqual(1n);
  });

  it('fails closed on missing prices', () => {
    const unknown = accountId('mystery.near');
    expect(() => tokenValueUsd(prices, unknown, 1n)).toThrow(MissingPriceError);
  });

  it('sums balances', () => {
    expect(
      sumValueUsd(
        [
          { token: WNEAR, raw: near(1) },
          { token: accountId('usdt.tether-token.near'), raw: usdt(5) },
        ],
        prices,
      ),
    ).toBe(10_000_000n);
  });
});
