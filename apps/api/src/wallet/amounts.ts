/**
 * Phase 4 — the one-click transaction engine. This is the first, precise building block: turning a recommendation's
 * approximate USD intent into an EXACT raw token amount to transact. Everything downstream (registration, the contract
 * builders, the pre-sign preview, the policy check) uses the raw amount; the human amount is only for display.
 *
 * The server never signs — it assembles transactions; the user signs them in their own wallet.
 */

export interface ResolvedAmount {
  /** Raw on-chain units (integer), floored — never rounds up, so an intent never spends more than intended. */
  readonly rawAmount: bigint;
  /** The same amount in human (decimal) units, for the preview. */
  readonly humanAmount: number;
}

/** Floor `human` (a decimal number) to `decimals` places and return it as raw integer units. Precise via a string;
 *  floors by TRUNCATION (toFixed rounds, so we take extra precision and then cut), so it never rounds up. */
export function toRawUnits(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human < 0)
    throw new RangeError('amount must be a non-negative finite number');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new RangeError('invalid decimals');
  const fixed = human.toFixed(decimals + 6); // round far below `decimals`, then drop the extra to truncate
  const [whole, frac = ''] = fixed.split('.');
  const fracTrunc = frac.slice(0, decimals).padEnd(decimals, '0');
  const digits = `${whole}${fracTrunc}`.replace(/^0+(?=\d)/, '');
  return BigInt(digits);
}

/**
 * Resolve an approximate USD intent into an exact raw amount of `token`, given its USD price and decimals. Capped at
 * `maxHuman` when provided (e.g. the wallet balance), so a "~$X" intent can never exceed what the user holds.
 */
export function resolveIntentAmount(
  approxUsd: number,
  priceUsd: number,
  decimals: number,
  maxHuman?: number,
): ResolvedAmount {
  if (!(priceUsd > 0)) throw new RangeError('a positive USD price is required to size the amount');
  let humanAmount = approxUsd / priceUsd;
  if (maxHuman !== undefined && humanAmount > maxHuman) humanAmount = maxHuman;
  return { rawAmount: toRawUnits(humanAmount, decimals), humanAmount };
}
