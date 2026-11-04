import type { UnitPrice } from '@near-autopilot/core';
import { valueUsd } from './valuation';

const BPS = 10_000n;

/** Minimum acceptable output for a quote with `slippageBps` tolerance (rounds down). */
export function minAmountOut(quotedAmountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be an integer in [0, 10000], got ${slippageBps}`);
  }
  return (quotedAmountOut * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * How much worse (in bps) the quoted output is than the oracle-implied output.
 * Positive = the pool pays less than the oracle says it should. Negative = better than oracle.
 * Used as a guard against manipulated or illiquid pools.
 */
export function oracleDeviationBps(args: {
  amountIn: bigint;
  priceIn: UnitPrice;
  amountOut: bigint;
  priceOut: UnitPrice;
}): number {
  const valueIn = valueUsd(args.amountIn, args.priceIn);
  const valueOut = valueUsd(args.amountOut, args.priceOut);
  if (valueIn === 0n) throw new RangeError('Input value is zero; cannot compute deviation');
  return Number(((valueIn - valueOut) * BPS) / valueIn);
}
