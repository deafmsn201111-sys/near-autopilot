import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nearUsd, poolMetrics, spearman, type PoolPoint } from '../src/thesis/analysis';
import { RAW_DIR, ROOT } from '../src/thesis/paths';
import { computeThesis, renderOutputs } from '../src/thesis/rebuild';

const DAY = 86_400_000;
const NEAR = 10n ** 24n;
const T0 = Date.UTC(2026, 7, 7);
const costs = { nearUsd: 2, gasPriceYocto: 100_000_000n, roundTripGas: 4n * 180_000_000_000_000n };

/** A synthetic pool: 1,000,000 NEAR / 2,000,000 USDC-like raw units, 1,000 shares; `step` mutates it per day. */
function pool(days: number, step: (p: PoolPoint, d: number) => PoolPoint): PoolPoint[] {
  let p: PoolPoint = {
    height: 1,
    t: T0,
    rN: 1_000_000n * NEAR,
    rO: 2_000_000n * 10n ** 6n,
    shares: 1_000n * NEAR,
    volN: 0n,
    volO: 0n,
    feeBps: 30,
    adminBps: 2_000,
  };
  const out = [p];
  for (let d = 1; d <= days; d += 1) {
    p = { ...step(p, d), height: d + 1, t: T0 + d * DAY };
    out.push(p);
  }
  return out;
}

describe('thesis analysis (synthetic pools with a known answer)', () => {
  it('at a constant price, LP vs HODL equals the share-value growth from fees, and IL is zero', () => {
    // Every day 100,000 NEAR of input volume; the LP share of the fee (0.3% x 80%) stays in the pool. Its value is
    // split evenly over both sides, so the price is unchanged and the pool's value grows by exactly the fee.
    const pts = pool(30, (p) => {
      const half = (100_000n * NEAR * 30n * 8_000n) / 100_000_000n / 2n;
      return {
        ...p,
        volN: p.volN + 100_000n * NEAR,
        rN: p.rN + half,
        rO: p.rO + (half * p.rO) / p.rN,
      };
    });
    const r = poolMetrics(1, 'usdc', pts, costs);
    if (!r) throw new Error('no metrics');
    expect(r.metrics.ilWindow).toBeCloseTo(0, 9);
    const growth = Number(pts[30]?.rN) / Number(pts[0]?.rN) - 1;
    expect(r.metrics.lpVsHodlWindow).toBeCloseTo(growth, 6);
    // Nominal (gross) is the LP share / 0.8; realized fee APR ~= LP vs HODL APR when the price does not move.
    expect(r.metrics.feeAprRealized).toBeCloseTo(r.metrics.lpVsHodlApr, 2);
    expect(r.metrics.nominalApr24hEnd ?? 0).toBeGreaterThan(r.metrics.feeAprRealized);
  });

  it('without fees, a 4x price move costs exactly the constant-product IL', () => {
    // Price of NEAR in the other token x4: k constant, rN halves, rO doubles.
    const pts = pool(10, (p, d) => (d === 10 ? { ...p, rN: p.rN / 2n, rO: p.rO * 2n } : p));
    const r = poolMetrics(1, 'usdc', pts, costs);
    if (!r) throw new Error('no metrics');
    const il = (2 * Math.sqrt(4)) / (1 + 4) - 1; // -20%
    expect(r.metrics.ilWindow).toBeCloseTo(il, 9);
    expect(r.metrics.lpVsHodlWindow).toBeCloseTo(il, 9);
    expect(r.metrics.netApr500 ?? 0).toBeLessThan(r.metrics.lpVsHodlApr); // costs only subtract
  });

  it('NEAR/USD needs both sources within 150 bps', () => {
    const at = 1_786_000_000;
    const line = (llama: number, cb: number) => ({
      height: 1,
      ts: at,
      defillama: { coins: { 'coingecko:near': { price: llama, timestamp: at - 30 } } },
      coinbase: [[at, 0, 0, 0, cb, 1]],
    });
    expect(nearUsd(line(2, 2.01)).usd).toBeCloseTo(2.005, 9);
    expect(nearUsd(line(2, 2.1)).usd).toBeNull();
    expect(nearUsd({ ...line(2, 2), coinbase: [] }).usd).toBeNull();
  });

  it('Spearman: +1, -1, ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(spearman([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.866, 3);
  });
});

describe.skipIf(!existsSync(resolve(RAW_DIR, 'manifest.json')))('thesis:rebuild', () => {
  it('the committed CSV, charts and THESIS.md are exactly what the committed raw data gives', () => {
    const files = renderOutputs(computeThesis());
    expect(Object.keys(files).sort()).toEqual([
      'THESIS.md',
      'thesis/out/burrow.csv',
      'thesis/out/charts/burrow-supply.svg',
      'thesis/out/charts/nominal-vs-realized.svg',
      'thesis/out/charts/tvl-vs-lp-vs-hodl.svg',
      'thesis/out/pools-daily.csv',
      'thesis/out/pools.csv',
    ]);
    for (const [path, content] of Object.entries(files))
      expect(readFileSync(resolve(ROOT, path), 'utf8'), path).toBe(content);
  });

  it('is deterministic: two rebuilds are byte-identical', () => {
    expect(renderOutputs(computeThesis())).toEqual(renderOutputs(computeThesis()));
  });
});
