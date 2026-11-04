import { normalize, type Decimal } from '../market-data/decimal';

/** Exact decimal helpers for yields. No float is ever used; divisions are floored at 18 fractional digits. */

export const SCALE_DIGITS = 18;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

export const dec = (mantissa: bigint, exponent = 0): Decimal => normalize({ mantissa, exponent });

/** raw / 10^decimals as an exact decimal. */
export const fromRaw = (raw: bigint, decimals: number): Decimal => dec(raw, -decimals);

export const mul = (a: Decimal, b: Decimal): Decimal =>
  dec(a.mantissa * b.mantissa, a.exponent + b.exponent);

export const add = (a: Decimal, b: Decimal): Decimal => {
  const e = Math.min(a.exponent, b.exponent);
  return dec(a.mantissa * pow10(a.exponent - e) + b.mantissa * pow10(b.exponent - e), e);
};

/** a / b floored to 18 fractional digits. b must be non-zero. */
export function div(a: Decimal, b: Decimal): Decimal {
  if (b.mantissa === 0n) throw new RangeError('division by zero');
  // a/b = (ma/mb) * 10^(ea-eb); compute ma*10^k/mb with enough digits.
  const k = SCALE_DIGITS + Math.max(0, b.exponent - a.exponent);
  const q = (a.mantissa * pow10(k)) / b.mantissa;
  return dec(q, a.exponent - b.exponent - k);
}

/** Ratio of two raw integers as a decimal fraction (18 digits, floored). */
export const ratio = (num: bigint, den: bigint): Decimal => div(dec(num), dec(den));

/** Fraction -> WAD (1e18 = 1.0), floored. */
export function toWad(d: Decimal): bigint {
  const shift = d.exponent + SCALE_DIGITS;
  return shift >= 0 ? d.mantissa * pow10(shift) : d.mantissa / pow10(-shift);
}

/** Fraction -> basis points, floored (for limits and display). */
export const toBps = (d: Decimal): bigint => (toWad(d) * 10_000n) / SCALE;

export const isNegative = (d: Decimal): boolean => d.mantissa < 0n;
