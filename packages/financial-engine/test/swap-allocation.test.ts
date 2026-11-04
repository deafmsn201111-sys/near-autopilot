import { describe, expect, it } from 'vitest';
import { computeAllocation, minAmountOut, oracleDeviationBps, planRebalance } from '../src';
import { NEAR_PRICE, USDT, USDT_PRICE, WNEAR, near, prices, usdt } from './fixtures';

describe('swap maths', () => {
  it('applies slippage tolerance rounding down', () => {
    expect(minAmountOut(1_000_000n, 50)).toBe(995_000n);
    expect(minAmountOut(999n, 100)).toBe(989n);
    expect(() => minAmountOut(1n, 10_001)).toThrow(RangeError);
  });

  it('measures deviation from the oracle', () => {
    // 1 NEAR ($5) in, 4.90 USDt out => 200 bps worse than oracle
    const dev = oracleDeviationBps({
      amountIn: near(1),
      priceIn: NEAR_PRICE,
      amountOut: 4_900_000n,
      priceOut: USDT_PRICE,
    });
    expect(dev).toBe(200);
    const better = oracleDeviationBps({
      amountIn: near(1),
      priceIn: NEAR_PRICE,
      amountOut: 5_100_000n,
      priceOut: USDT_PRICE,
    });
    expect(better).toBe(-200);
  });
});

describe('allocation', () => {
  const targets = new Map([
    [WNEAR, 5_000],
    [USDT, 5_000],
  ]);

  it('computes drift', () => {
    const { totalUsd, lines } = computeAllocation(
      [
        { token: WNEAR, raw: near(100) },
        { token: USDT, raw: usdt(100) },
      ],
      prices,
      targets,
    );
    expect(totalUsd).toBe(600_000_000n);
    expect(lines.find((l) => l.token === WNEAR)?.driftBps).toBe(3_333);
  });

  it('requires weights that sum to 100%', () => {
    expect(() => computeAllocation([], prices, new Map([[WNEAR, 5_000]]))).toThrow(RangeError);
  });

  it('plans a trade capped by maxTradeUsd', () => {
    const plan = planRebalance({
      balances: [
        { token: WNEAR, raw: near(100) },
        { token: USDT, raw: usdt(100) },
      ],
      prices,
      targets,
      thresholdBps: 500,
      maxTradeUsd: 50_000_000n,
    });
    expect(plan?.sell.token).toBe(WNEAR);
    expect(plan?.buy.token).toBe(USDT);
    expect(plan?.sellValueUsd).toBe(50_000_000n);
  });

  it('does nothing below the drift threshold', () => {
    const plan = planRebalance({
      balances: [
        { token: WNEAR, raw: near(10) },
        { token: USDT, raw: usdt(50) },
      ],
      prices,
      targets,
      thresholdBps: 500,
      maxTradeUsd: 1_000_000_000n,
    });
    expect(plan).toBeNull();
  });
});
