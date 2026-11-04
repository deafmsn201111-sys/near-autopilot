import type { AssetBalance, PriceMap, TokenId } from '@near-autopilot/core';
import { rawForValueUsd, priceOf, tokenValueUsd } from './valuation';

const BPS = 10_000n;

export interface AllocationLine {
  readonly token: TokenId;
  readonly valueUsd: bigint;
  readonly currentBps: number;
  readonly targetBps: number;
  /** current − target. Positive = overweight. */
  readonly driftBps: number;
}

export interface RebalancePlan {
  readonly sell: AllocationLine;
  readonly buy: AllocationLine;
  readonly sellAmountRaw: bigint;
  readonly sellValueUsd: bigint;
}

/**
 * Allocation across the target tokens only (other wallet tokens are ignored).
 * `targets` must sum to exactly 10_000 bps.
 */
export function computeAllocation(
  balances: readonly AssetBalance[],
  prices: PriceMap,
  targets: ReadonlyMap<TokenId, number>,
): { totalUsd: bigint; lines: AllocationLine[] } {
  const targetSum = [...targets.values()].reduce((a, b) => a + b, 0);
  if (targetSum !== 10_000)
    throw new RangeError(`Target weights must sum to 10000 bps, got ${targetSum}`);

  const raw = new Map<TokenId, bigint>();
  for (const b of balances)
    if (targets.has(b.token)) raw.set(b.token, (raw.get(b.token) ?? 0n) + b.raw);

  const values = [...targets.keys()].map((token) => ({
    token,
    value: tokenValueUsd(prices, token, raw.get(token) ?? 0n),
  }));
  const totalUsd = values.reduce((sum, v) => sum + v.value, 0n);

  const lines = values.map(({ token, value }) => {
    const currentBps = totalUsd === 0n ? 0 : Number((value * BPS) / totalUsd);
    const targetBps = targets.get(token) ?? 0;
    return { token, valueUsd: value, currentBps, targetBps, driftBps: currentBps - targetBps };
  });
  return { totalUsd, lines };
}

/**
 * Picks the most overweight and most underweight tokens and sizes a single trade that moves the
 * overweight token back toward target, capped at `maxTradeUsd` and at the wallet balance.
 * Returns null if the largest absolute drift is below `thresholdBps`.
 */
export function planRebalance(args: {
  balances: readonly AssetBalance[];
  prices: PriceMap;
  targets: ReadonlyMap<TokenId, number>;
  thresholdBps: number;
  maxTradeUsd: bigint;
}): RebalancePlan | null {
  const { totalUsd, lines } = computeAllocation(args.balances, args.prices, args.targets);
  if (totalUsd === 0n || lines.length < 2) return null;

  const sorted = [...lines].sort((a, b) => b.driftBps - a.driftBps);
  const sell = sorted[0];
  const buy = sorted[sorted.length - 1];
  if (!sell || !buy || sell.token === buy.token) return null;
  if (Math.max(Math.abs(sell.driftBps), Math.abs(buy.driftBps)) < args.thresholdBps) return null;
  if (sell.driftBps <= 0 || buy.driftBps >= 0) return null;

  // Move the smaller of the two excesses so neither token overshoots its target.
  const excessSell = (totalUsd * BigInt(sell.driftBps)) / BPS;
  const deficitBuy = (totalUsd * BigInt(-buy.driftBps)) / BPS;
  let sellValue = excessSell < deficitBuy ? excessSell : deficitBuy;
  if (sellValue > args.maxTradeUsd) sellValue = args.maxTradeUsd;
  if (sellValue <= 0n) return null;

  const held = args.balances.filter((b) => b.token === sell.token).reduce((s, b) => s + b.raw, 0n);
  let amount = rawForValueUsd(sellValue, priceOf(args.prices, sell.token));
  if (amount > held) amount = held;
  if (amount <= 0n) return null;

  return {
    sell,
    buy,
    sellAmountRaw: amount,
    sellValueUsd: tokenValueUsd(args.prices, sell.token, amount),
  };
}
