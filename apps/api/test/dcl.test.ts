import { describe, expect, it } from 'vitest';
import { divergenceShare, estimateDcl, type DclPoint } from '../src/analytics/dcl';

const DEC: [number, number] = [6, 24]; // USDC / wNEAR, as on Rhea mainnet
const LN = Math.log(1.0001);
const P0 = 401_540;

/** 72 hours of 15-minute observations: the price walks `move` points over the window; fees accrue evenly. */
function series(
  move: number,
  feeStepX = 10_000_000n,
  liquidity = 38_284_447_321_456_862n,
): DclPoint[] {
  const n = 289;
  return Array.from({ length: n }, (_, k) => ({
    at: new Date(Date.UTC(2026, 10, 1) + k * 900_000),
    point: P0 + Math.round((move * k) / (n - 1)),
    liquidity,
    feeX: BigInt(k) * feeStepX,
    feeY: 0n,
  }));
}

describe('DCL estimate (concentrated liquidity, analysis only)', () => {
  it('the divergence loss matches the closed-form concentrated-liquidity formula, and the classic one on a wide range', () => {
    const k = 1.21;
    const d = Math.round(Math.log(k) / LN);
    const classic = 1 - (2 * Math.sqrt(k)) / (1 + k);
    expect(divergenceShare(P0 - 150_000, P0 + 150_000, P0, P0 + d, DEC)).toBeCloseTo(classic, 4);
    // range [1/1.5, 1.5] of the entry price: continuous formula 2.466 %
    const half = Math.round(Math.log(1.5) / LN);
    expect(divergenceShare(P0 - half, P0 + half, P0, P0 + d, DEC)).toBeCloseTo(0.02466, 3);
    expect(divergenceShare(P0 - half, P0 + half, P0, P0, DEC)).toBe(0);
  });

  it('a range the price leaves earns fees only while inside; a wider range stays in and loses less to divergence', () => {
    const e = estimateDcl({
      points: series(Math.round(Math.log(1.1) / LN)), // +10 % over the window
      feePpm: 100,
      decimals: DEC,
      pricesUsd: [1, 3.7],
      capitalUsd: 1000,
      horizonDays: 30,
      gasUsdPerTx: 0.05,
    });
    expect(e.status).toBe('OK');
    const [narrow, mid, wide] = e.ranges;
    expect(narrow?.inRangeShare).toBeLessThan(0.6); // ±5 %: out after half the walk
    expect(mid?.inRangeShare).toBeGreaterThan(0.99);
    expect(wide?.inRangeShare).toBeGreaterThan(0.99);
    expect(wide?.divergenceLossUsd ?? 0).toBeLessThan(mid?.divergenceLossUsd ?? 0);
    expect(mid?.backtest.divergenceLossUsd ?? 0).toBeGreaterThan(0);
    // pool LP fees: 288 steps x 10 USDC x 80 % (the protocol keeps 20 %)
    expect(e.poolLpFeesUsd).toBeCloseTo(288 * 10 * 0.8, 3);
    for (const r of e.ranges)
      expect(r.netUsd).toBeCloseTo(r.feesUsd - r.divergenceLossUsd - r.swapUsd - r.gasUsd, 6);
  });

  it('refuses to estimate from too little history or broken counters', () => {
    const base = {
      feePpm: 100,
      decimals: DEC,
      pricesUsd: [1, 3.7] as [number, number],
      capitalUsd: 1000,
      horizonDays: 30,
      gasUsdPerTx: 0.05,
    };
    expect(estimateDcl({ ...base, points: series(0).slice(0, 20) }).status).toBe(
      'INSUFFICIENT_DATA',
    );
    const broken = series(0);
    broken[100] = { ...broken[100]!, feeX: 0n };
    expect(estimateDcl({ ...base, points: broken }).reason).toMatch(/backwards/);
  });
});
