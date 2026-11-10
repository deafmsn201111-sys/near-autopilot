import { describe, expect, it } from 'vitest';
import {
  POINT_MAX,
  POINT_MIN,
  Q96,
  SQRT_RATE_X96,
  assertValidRange,
  computeLiquidity,
  decimalPriceToPoint,
  depositPerUnitLiquidityX96,
  feeToPointDelta,
  floorToPointDelta,
  pointToDecimalPrice,
  requiredDepositForLiquidity,
  sqrtPriceX96,
} from '../src';

describe('sqrtPriceX96 (ported from ref-ui compute_liquidity.ts)', () => {
  it('reproduces the MIN/MAX constants that ref-ui documents next to the table', () => {
    // ref-ui compute_liquidity.ts: MIN_PRICE = sqrt(1.0001^-800000) * 2^96, MAX_PRICE likewise for +800000
    expect(sqrtPriceX96(POINT_MIN)).toBe(337263108622n);
    expect(sqrtPriceX96(POINT_MAX)).toBe(18611883644907511909590774894315720731532604461n);
  });

  it('is exactly 2^96 at point 0 and strictly increasing', () => {
    expect(sqrtPriceX96(0)).toBe(Q96);
    let previous = sqrtPriceX96(-50);
    for (let p = -49; p <= 50; p += 1) {
      const next = sqrtPriceX96(p);
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  it('approximates sqrt(1.0001^p) * 2^96 to within float error', () => {
    for (const p of [-100000, -1234, 1, 7, 431416, 799999]) {
      const exact = Number(sqrtPriceX96(p)) / Number(Q96);
      const expected = Math.sqrt(Math.pow(1.0001, p));
      expect(Math.abs(exact / expected - 1) < 1e-9).toBe(true);
    }
  });

  it('rejects points outside the legal range instead of returning 0', () => {
    expect(() => sqrtPriceX96(POINT_MAX + 1)).toThrow(RangeError);
    expect(() => sqrtPriceX96(POINT_MIN - 1)).toThrow(RangeError);
    expect(() => sqrtPriceX96(1.5)).toThrow(RangeError);
  });

  it('exposes sqrt(1.0001) as the point-1 price', () => {
    expect(SQRT_RATE_X96).toBe(sqrtPriceX96(1));
  });
});

describe('price <-> point', () => {
  it('maps fee tiers to point deltas (ref-sdk feeToPointDelta)', () => {
    expect([100, 400, 2000, 10000].map(feeToPointDelta)).toEqual([1, 8, 40, 200]);
    expect(() => feeToPointDelta(500)).toThrow(RangeError);
  });

  it('floors toward -infinity like ref-sdk getPointByPrice', () => {
    expect(floorToPointDelta(431419, 8)).toBe(431416);
    expect(floorToPointDelta(-1, 40)).toBe(-40);
    expect(floorToPointDelta(-40, 40)).toBe(-40);
  });

  // Vector from the ref-sdk README-style example: 0.9 USDT(6 dec) buys 4.89454792 wNEAR(24 dec), fee 400
  it('priceToPoint matches the published SDK vector (431416) and decimal price round-trips', () => {
    const point = decimalPriceToPoint({
      priceYPerX: 4.89454792 / 0.9,
      decimalsX: 6,
      decimalsY: 24,
      fee: 400,
    });
    expect(point).toBe(431416);
    const price = pointToDecimalPrice(431416, 6, 24);
    expect(Math.abs(price / 5.43528191708623 - 1) < 1e-12).toBe(true);
  });

  it('clamps to the legal range', () => {
    expect(decimalPriceToPoint({ priceYPerX: 1e300, decimalsX: 0, decimalsY: 0, fee: 100 })).toBe(
      POINT_MAX,
    );
    expect(decimalPriceToPoint({ priceYPerX: 1e-300, decimalsX: 0, decimalsY: 0, fee: 100 })).toBe(
      POINT_MIN,
    );
    expect(() =>
      decimalPriceToPoint({ priceYPerX: 0, decimalsX: 0, decimalsY: 0, fee: 100 }),
    ).toThrow(RangeError);
  });
});

describe('range validation', () => {
  it('requires ordered, in-bounds, delta-aligned endpoints', () => {
    expect(() => assertValidRange(288680, 289000, 40)).not.toThrow();
    expect(() => assertValidRange(289000, 288680, 40)).toThrow(RangeError);
    expect(() => assertValidRange(288681, 289000, 40)).toThrow(RangeError);
    expect(() => assertValidRange(POINT_MIN - 40, 0, 40)).toThrow(RangeError);
  });
});

describe('liquidity math', () => {
  // predict_add_liquidity result observed on-chain (tier B): a usdc/wrap 0.2% pool,
  // left 288680, right 289000, amount_x 1000000, amount_y 1e24 -> liquidity_amount 5842542192, need_x 1000000, need_y 0.
  // The pool was below the range (need_y = 0), and the result is independent of where below the range it sits.
  it('reproduces the on-chain predict_add_liquidity vector for a range above the current point', () => {
    for (const currentPoint of [200000, 280000, 288000]) {
      const liquidity = computeLiquidity({
        leftPoint: 288680,
        rightPoint: 289000,
        currentPoint,
        amountX: 1_000_000n,
        amountY: 10n ** 24n,
      });
      expect(liquidity).toBe(5842542192n);
      expect(
        requiredDepositForLiquidity({
          liquidity,
          leftPoint: 288680,
          rightPoint: 289000,
          currentPoint,
        }),
      ).toEqual({
        x: 1_000_000n,
        y: 0n,
      });
    }
  });

  it('range entirely below the current point needs only token Y', () => {
    const per = depositPerUnitLiquidityX96(100, 200, 500);
    expect(per.x).toBe(0n);
    expect(per.y > 0n).toBe(true);
  });

  it('range straddling the current point needs both tokens', () => {
    const per = depositPerUnitLiquidityX96(-400, 400, 0);
    expect(per.x > 0n && per.y > 0n).toBe(true);
  });

  it('never requires more than the amounts it was sized from (property check over many ranges)', () => {
    const delta = 40;
    const currents = [-5000, -37, 0, 41, 123456];
    const amountsX = [1n, 999n, 10n ** 9n, 10n ** 18n];
    let checked = 0;
    for (const current of currents) {
      for (let left = -3200; left <= 3200; left += 1600) {
        for (let width = delta; width <= 4000; width += 1960) {
          const right = left + width;
          if (right > POINT_MAX) continue;
          for (const amountX of amountsX) {
            const amountY = amountX * 7n + 3n;
            const liquidity = computeLiquidity({
              leftPoint: left,
              rightPoint: right,
              currentPoint: current,
              amountX,
              amountY,
            });
            const need = requiredDepositForLiquidity({
              liquidity,
              leftPoint: left,
              rightPoint: right,
              currentPoint: current,
            });
            expect(need.x <= amountX).toBe(true);
            expect(need.y <= amountY).toBe(true);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('returns zero liquidity (not negative) when token Y is required but none is supplied', () => {
    expect(
      computeLiquidity({
        leftPoint: -400,
        rightPoint: 400,
        currentPoint: 0,
        amountX: 10n ** 12n,
        amountY: 0n,
      }),
    ).toBe(0n);
  });

  it('rejects negative amounts', () => {
    expect(() =>
      computeLiquidity({
        leftPoint: 0,
        rightPoint: 40,
        currentPoint: -80,
        amountX: -1n,
        amountY: 0n,
      }),
    ).toThrow(RangeError);
  });
});
