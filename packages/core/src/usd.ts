/** All USD values in this codebase are bigint micro-USD (1 USD = 1_000_000). */
export const USD_SCALE = 1_000_000n;

/**
 * True when `value` is a finite number whose shortest decimal form has at most `places` fractional digits and no
 * exponent (so it converts to a scaled integer exactly). `1.3` and `100` pass for any places >= 1; `0.1234567` fails
 * for 6; `1e-7` and `1e21` always fail.
 */
export function hasAtMostDecimals(value: number, places: number): boolean {
  if (!Number.isFinite(value)) return false;
  const match = /^-?\d+(?:\.(\d+))?$/.exec(String(value));
  return match !== null && (match[1]?.length ?? 0) <= places;
}

/**
 * Exact decimal-number -> scaled bigint (e.g. 1.3 at 4 places -> 13000n). Parses the decimal string, never multiplies
 * floats, and throws instead of rounding when the value has more precision than `places`.
 */
export function decimalToScaled(value: number, places: number): bigint {
  if (!hasAtMostDecimals(value, places)) {
    throw new RangeError(`${value} is not representable with ${places} decimal places`);
  }
  const [whole = '0', frac = ''] = String(value).replace('-', '').split('.');
  const scaled = BigInt(whole) * 10n ** BigInt(places) + BigInt(frac.padEnd(places, '0') || '0');
  return value < 0 ? -scaled : scaled;
}

/** Config USD (a JSON number with at most 6 decimals) -> micro-USD, exactly. */
export function usdToMicro(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`Invalid USD amount: ${usd}`);
  return decimalToScaled(usd, 6);
}

/** Formats micro-USD as a plain decimal string with 2-6 fractional digits, e.g. "1234.50". */
export function formatMicroUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / USD_SCALE;
  let frac = (abs % USD_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
