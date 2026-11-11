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

/** An amount an orchestrator agent already sized in base units, capped at what the wallet holds. */
export function exactAmount(amount: bigint, walletRaw: bigint, decimals: number): ResolvedAmount {
  const rawAmount = amount < walletRaw ? amount : walletRaw;
  return { rawAmount, humanAmount: Number(rawAmount) / 10 ** decimals };
}

/** One side of a balanced liquidity deposit. */
export interface LpSide {
  readonly rawAmount: bigint;
  readonly humanAmount: number;
}

/**
 * Size a balanced ("50/50") deposit into a two-token v1 pool. The two contributions are kept in the pool's
 * CURRENT reserve ratio, so the contract consumes both fully and nothing is stranded — this is what "equal
 * halves" means for a balanced pool, where each side is ~half the value. The total value targets `budgetUsd`,
 * then each side is capped at the wallet holding; if a cap binds, BOTH sides scale down together so the ratio
 * (and thus "no leftover") is preserved. Amounts are floored, never rounded up.
 *
 * `reserve*` are raw pool reserves (as `get_pool` reports), `price*` USD per whole token, `wallet*Human` the
 * signer's holdings in whole tokens.
 */
export function resolveBalancedLpAmounts(args: {
  readonly budgetUsd: number;
  readonly reserve0Human: number;
  readonly reserve1Human: number;
  readonly price0Usd: number;
  readonly price1Usd: number;
  readonly decimals0: number;
  readonly decimals1: number;
  readonly wallet0Human: number;
  readonly wallet1Human: number;
}): { readonly side0: LpSide; readonly side1: LpSide } {
  const { budgetUsd, reserve0Human, reserve1Human, price0Usd, price1Usd } = args;
  if (!(budgetUsd > 0)) throw new RangeError('budget must be positive');
  if (!(reserve0Human > 0) || !(reserve1Human > 0))
    throw new RangeError('both pool reserves must be positive');
  if (!(price0Usd > 0) || !(price1Usd > 0)) throw new RangeError('both prices must be positive');

  // Keep amount0/amount1 = reserve0/reserve1 (human units). Let amount1 = x, amount0 = x * ratio.
  const ratio = reserve0Human / reserve1Human;
  // budget = amount0 * price0 + amount1 * price1 = x * (ratio * price0 + price1).
  let x1 = budgetUsd / (ratio * price0Usd + price1Usd);
  let x0 = x1 * ratio;
  // Cap by wallet holdings, scaling BOTH sides by the tightest binding ratio to preserve the pool ratio.
  let scale = 1;
  if (x0 > args.wallet0Human) scale = Math.min(scale, args.wallet0Human / x0);
  if (x1 > args.wallet1Human) scale = Math.min(scale, args.wallet1Human / x1);
  if (scale < 1) {
    x0 *= scale;
    x1 *= scale;
  }
  return {
    side0: { rawAmount: toRawUnits(x0, args.decimals0), humanAmount: x0 },
    side1: { rawAmount: toRawUnits(x1, args.decimals1), humanAmount: x1 },
  };
}
