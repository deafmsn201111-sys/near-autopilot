import type { UnitPrice } from '@near-autopilot/core';

/**
 * Exact decimal: value = mantissa x 10^exponent. Prices are carried in this form end to end; no float arithmetic is
 * ever done on a price. (DefiLlama returns JSON numbers: they are converted from their shortest round-trip decimal
 * text, which is the literal the server sent for any value with <= 17 significant digits.)
 */
export interface Decimal {
  readonly mantissa: bigint;
  readonly exponent: number;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** "3.98", "1e-7", "-2.5E+3" -> Decimal. Rejects anything that is not a finite plain/scientific decimal. */
export function parseDecimal(text: string): Decimal | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) return null;
  const [, sign = '', whole = '0', frac = '', exp = '0'] = m;
  const e = Number(exp) - frac.length;
  if (!Number.isSafeInteger(e) || Math.abs(e) > 60) return null;
  const mantissa = BigInt(`${sign}${whole}${frac}`);
  return normalize({ mantissa, exponent: e });
}

/** A JSON number as the server wrote it. Null for NaN/Infinity. */
export function decimalFromJsonNumber(n: number): Decimal | null {
  return Number.isFinite(n) ? parseDecimal(String(n)) : null;
}

/** Strips trailing zeros so equal values have one representation. */
export function normalize(d: Decimal): Decimal {
  let { mantissa, exponent } = d;
  if (mantissa === 0n) return { mantissa: 0n, exponent: 0 };
  while (mantissa % 10n === 0n) {
    mantissa /= 10n;
    exponent += 1;
  }
  return { mantissa, exponent };
}

export function formatDecimal(d: Decimal): string {
  const { mantissa, exponent } = normalize(d);
  if (exponent >= 0) return (mantissa * pow10(exponent)).toString();
  const negative = mantissa < 0n;
  const digits = (negative ? -mantissa : mantissa).toString().padStart(-exponent + 1, '0');
  const cut = digits.length + exponent;
  return `${negative ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

/** Compares a and b exactly: -1, 0, 1. */
export function compareDecimal(a: Decimal, b: Decimal): number {
  const e = Math.min(a.exponent, b.exponent);
  const x = a.mantissa * pow10(a.exponent - e);
  const y = b.mantissa * pow10(b.exponent - e);
  return x === y ? 0 : x < y ? -1 : 1;
}

/** |a - b| / min(a, b) in basis points, floored. Both must be positive. */
export function deviationBps(a: Decimal, b: Decimal): bigint {
  const e = Math.min(a.exponent, b.exponent);
  const x = a.mantissa * pow10(a.exponent - e);
  const y = b.mantissa * pow10(b.exponent - e);
  if (x <= 0n || y <= 0n) throw new RangeError('deviationBps needs positive prices');
  const lo = x < y ? x : y;
  return ((x > y ? x - y : y - x) * 10_000n) / lo;
}

/**
 * USD per whole token -> the core `UnitPrice` (USD per RAW unit = multiplier / 10^decimals), exactly:
 * price m x 10^e per 10^tokenDecimals raw units.
 */
export function toUnitPrice(usdPerToken: Decimal, tokenDecimals: number): UnitPrice {
  const { mantissa, exponent } = normalize(usdPerToken);
  if (mantissa <= 0n) throw new RangeError('a unit price must be positive');
  return exponent >= 0
    ? { multiplier: mantissa * pow10(exponent), decimals: tokenDecimals }
    : { multiplier: mantissa, decimals: tokenDecimals - exponent };
}
