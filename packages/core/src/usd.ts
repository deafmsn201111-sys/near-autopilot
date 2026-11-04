/** All USD values in this codebase are bigint micro-USD (1 USD = 1_000_000). */
export const USD_SCALE = 1_000_000n;

export function usdToMicro(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new RangeError(`Invalid USD amount: ${usd}`);
  return BigInt(Math.round(usd * 1_000_000));
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
