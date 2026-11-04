/**
 * Burrow stores balances in "inner" units: raw token units * 10^extra_decimals (S: fungible_token.rs
 * `ft_on_transfer` multiplies by it, `internal_ft_transfer` divides). Views (`get_account`) return inner
 * units. Core and the financial engine work in RAW token units, so every boundary converts explicitly.
 */

export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 77)
    throw new RangeError(`Invalid exponent ${exponent}`);
  return 10n ** BigInt(exponent);
}

export function rawToInner(raw: bigint, extraDecimals: number): bigint {
  if (raw < 0n) throw new RangeError('amount must be non-negative');
  return raw * pow10(extraDecimals);
}

/** `ceil` for debt (never understate what is owed), `floor` for assets (never overstate what is held). */
export function innerToRaw(
  inner: bigint,
  extraDecimals: number,
  rounding: 'floor' | 'ceil',
): bigint {
  if (inner < 0n) throw new RangeError('amount must be non-negative');
  const factor = pow10(extraDecimals);
  const quotient = inner / factor;
  return rounding === 'ceil' && inner % factor !== 0n ? quotient + 1n : quotient;
}
