import { describe, expect, it } from 'vitest';
import { swapCost } from '../src/wallet/swap-cost';

const base = {
  amountIn: 1_000n * 10n ** 24n,
  decIn: 24,
  priceIn: 3,
  amountOut: 2_700n * 10n ** 6n,
  decOut: 6,
  symOut: 'USDC',
  priceOut: 1,
  slippageBps: 50,
  reserves: { in: 10_000n * 10n ** 24n, out: 30_000n * 10n ** 6n },
};

describe('swapCost', () => {
  it('prices both sides in USD and measures the impact against the pool mid-price', () => {
    const c = swapCost(base);
    expect(c.estReceived).toEqual({ raw: '2700000000', human: 2700, symbol: 'USDC', usd: 2700 });
    expect(c.minReceived).toEqual({
      raw: '2686500000',
      human: 2686.5,
      symbol: 'USDC',
      usd: 2686.5,
    });
    expect(c.slippageBps).toBe(50);
    expect(c.priceImpactPct).toBeCloseTo(10, 9);
  });

  it('leaves USD out when a side has no confirmed price', () => {
    const c = swapCost({ ...base, priceOut: undefined });
    expect(c.estReceived).not.toHaveProperty('usd');
    expect(c.minReceived).not.toHaveProperty('usd');
  });

  it('has no impact for a pool whose reserves are not its price', () => {
    expect(swapCost({ ...base, reserves: null }).priceImpactPct).toBeNull();
  });

  it('never reports a negative impact', () => {
    expect(swapCost({ ...base, amountOut: 3_100n * 10n ** 6n }).priceImpactPct).toBe(0);
  });
});
