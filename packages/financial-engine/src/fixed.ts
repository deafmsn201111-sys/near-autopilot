/**
 * Exact fixed-point primitives. Every amount, price, ratio and rate in this package is a `bigint`; there is no
 * `number` arithmetic on money anywhere in `src/`. Scales are explicit in names:
 *
 *   WAD   10^18   general ratios and rates (1.0 = 10^18)
 *   BPS   10^4    basis points (config values, tolerances)
 *   PPM   10^6    fee tiers (3000 ppm = 0.30%)
 *   Q96   2^96    square-root prices (concentrated liquidity)
 *
 * Rounding is never implicit. Each function that divides takes (or documents) a rounding mode, and callers choose
 * the direction that can only make a result look worse for the user (collateral down, debt up, costs up).
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const PPM = 1_000_000n;
export const Q96 = 1n << 96n;
export const Q128 = 1n << 128n;
export const Q192 = 1n << 192n;
export const U256_MOD = 1n << 256n;
export const SECONDS_PER_DAY = 86_400n;
/** 365-day year. An assumption, not a calendar fact: leap years are ignored on purpose (see docs). */
export const SECONDS_PER_YEAR = 365n * SECONDS_PER_DAY;

/** `floor` = toward -infinity, `ceil` = toward +infinity, `nearest` = ties away from zero. */
export type Rounding = 'floor' | 'ceil' | 'nearest';
/** Directed rounding only (used where "nearest" would hide a bias). */
export type Directed = 'floor' | 'ceil';

/** n / d for any-sign n and positive d. */
export function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
  if (d <= 0n) throw new RangeError('divisor must be positive');
  const q = n / d; // truncates toward zero
  const r = n % d; // has the sign of n
  if (r === 0n) return q;
  switch (mode) {
    case 'floor':
      return n < 0n ? q - 1n : q;
    case 'ceil':
      return n > 0n ? q + 1n : q;
    case 'nearest': {
      const twice = (r < 0n ? -r : r) * 2n;
      if (twice < d) return q;
      return n < 0n ? q - 1n : q + 1n;
    }
  }
}

/** (a * b) / d, exact intermediate (no overflow in bigint), rounded as requested. */
export function mulDiv(a: bigint, b: bigint, d: bigint, mode: Rounding = 'floor'): bigint {
  return divRound(a * b, d, mode);
}

/** floor(sqrt(n)). Newton iteration from an upper bound; exact for all n >= 0. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1); // >= sqrt(n)
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** sqrt of a WAD-scaled value, WAD-scaled, rounded down. */
export function sqrtWad(x: bigint): bigint {
  return isqrt(x * WAD);
}

/** base^exponent for a WAD-scaled base and a non-negative integer exponent; every step rounds to nearest. */
export function powWad(base: bigint, exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0)
    throw new RangeError('exponent must be a non-negative integer');
  let result = WAD;
  let b = base;
  let e = exponent;
  while (e > 0) {
    if (e & 1) result = mulDiv(result, b, WAD, 'nearest');
    e = Math.floor(e / 2);
    if (e > 0) b = mulDiv(b, b, WAD, 'nearest');
  }
  return result;
}

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
export const absBig = (a: bigint): bigint => (a < 0n ? -a : a);

export function clampBig(x: bigint, lo: bigint, hi: bigint): bigint {
  if (lo > hi) throw new RangeError('clamp: lo > hi');
  return x < lo ? lo : x > hi ? hi : x;
}

export function assertBps(value: number, name: string, max = 10_000): void {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError(`${name} must be an integer in [0, ${max}], got ${value}`);
}

export function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) throw new RangeError(`${name} must be non-negative`);
}

/**
 * Parses a decimal string ("1234.5678", "-0.01") into integer units at `decimals` places. Never rounds: more
 * fractional digits than `decimals` is an error, so a typo cannot silently lose value.
 */
export function parseUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new RangeError('decimals must be a non-negative integer');
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`Not a plain decimal number: "${text}"`);
  const [, sign, whole, frac = ''] = m;
  if (frac.length > decimals)
    throw new RangeError(`"${text}" has more than ${decimals} fractional digits`);
  const units = BigInt(whole! + frac.padEnd(decimals, '0'));
  return sign ? -units : units;
}

/** Inverse of `parseUnits`: exact, trailing zeros trimmed. */
export function formatUnits(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0)
    throw new RangeError('decimals must be a non-negative integer');
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
