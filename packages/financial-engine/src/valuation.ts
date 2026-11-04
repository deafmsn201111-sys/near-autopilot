import {
  MissingPriceError,
  USD_SCALE,
  type AssetBalance,
  type PriceMap,
  type TokenId,
  type UnitPrice,
} from '@near-autopilot/core';

function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0)
    throw new RangeError(`Invalid exponent ${exponent}`);
  return 10n ** BigInt(exponent);
}

/** micro-USD value of `raw` units at `price` (rounds down). */
export function valueUsd(raw: bigint, price: UnitPrice): bigint {
  return (raw * price.multiplier * USD_SCALE) / pow10(price.decimals);
}

/**
 * Inverse of `valueUsd`: the raw token amount worth at least `valueMicro` (rounds up so that the
 * caller never under-covers a target). Throws if the price is zero.
 */
export function rawForValueUsd(valueMicro: bigint, price: UnitPrice): bigint {
  const denominator = price.multiplier * USD_SCALE;
  if (denominator === 0n) throw new RangeError('Cannot convert value to amount at a zero price');
  const numerator = valueMicro * pow10(price.decimals);
  return (numerator + denominator - 1n) / denominator;
}

export function priceOf(prices: PriceMap, token: TokenId): UnitPrice {
  const price = prices.get(token);
  if (!price) throw new MissingPriceError(token);
  return price;
}

export function tokenValueUsd(prices: PriceMap, token: TokenId, raw: bigint): bigint {
  return valueUsd(raw, priceOf(prices, token));
}

export function sumValueUsd(balances: readonly AssetBalance[], prices: PriceMap): bigint {
  return balances.reduce((total, b) => total + tokenValueUsd(prices, b.token, b.raw), 0n);
}
