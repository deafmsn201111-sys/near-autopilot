import { describe, expect, it } from 'vitest';
import {
  allocateConstrained,
  InfeasibleAllocationError,
  limitTurnover,
  turnoverBps,
  weightsToAmounts,
  type AllocationAsset,
  type GroupCap,
} from '../src';
import { forAll, type Gen } from './support/prop';

const pct = (n: number) => BigInt(n) * 10n ** 16n; // n% as WAD
const asset = (
  id: string,
  yieldPct: number,
  minBps: number,
  maxBps: number,
  group?: string,
): AllocationAsset => ({
  id,
  minBps,
  maxBps,
  estimatedYieldWad: pct(yieldPct),
  ...(group === undefined ? {} : { group }),
});
const obj = (m: ReadonlyMap<string, number | bigint>) => Object.fromEntries(m);

describe('allocateConstrained: hand-computed fixtures', () => {
  const A = asset('A', 10, 0, 5000);
  const B = asset('B', 8, 1000, 6000);
  const C = asset('C', 2, 0, 10_000);

  it('fills the best yield to its cap, then the next: A 50%, B 50%, C 0%, yield 9%', () => {
    const r = allocateConstrained({ assets: [A, B, C] });
    expect(obj(r.weightsBps)).toEqual({ A: 5000, B: 5000, C: 0 });
    expect(r.estimatedPortfolioYield).toEqual({ basis: 'estimated', wad: pct(9) });
  });

  it('a group cap diverts weight to the next-best asset: A 50%, B 10%, C 40%, yield 6.6%', () => {
    const r = allocateConstrained({
      assets: [A, B, C].map((x, i) => (i < 2 ? { ...x, group: 'g' } : x)),
      groupCaps: [{ group: 'g', maxBps: 6000 }],
    });
    expect(obj(r.weightsBps)).toEqual({ A: 5000, B: 1000, C: 4000 });
    // 0.5*10% + 0.1*8% + 0.4*2% = 5% + 0.8% + 0.8% = 6.6%
    expect(r.estimatedPortfolioYield.wad).toBe(660n * 10n ** 14n);
  });

  it('minimums are honoured even for the worst asset', () => {
    const r = allocateConstrained({
      assets: [asset('good', 10, 0, 10_000), asset('bad', -5, 2000, 10_000)],
    });
    expect(obj(r.weightsBps)).toEqual({ good: 8000, bad: 2000 });
    expect(r.estimatedPortfolioYield.wad).toBe(pct(8) - pct(1)); // 0.8*10% + 0.2*-5% = 7%
  });

  it('negative yields: capital still has to go somewhere (weights sum to 100%)', () => {
    const r = allocateConstrained({
      assets: [asset('a', -1, 0, 10_000), asset('b', -3, 0, 10_000)],
    });
    expect(obj(r.weightsBps)).toEqual({ a: 10_000, b: 0 });
    expect(r.estimatedPortfolioYield.wad).toBe(-pct(1));
  });

  it('is deterministic under ties and independent of input order (ties go to the smaller id)', () => {
    const xs = [asset('b', 5, 0, 6000), asset('a', 5, 0, 6000), asset('c', 5, 0, 6000)];
    const first = obj(allocateConstrained({ assets: xs }).weightsBps);
    expect(first).toEqual({ a: 6000, b: 4000, c: 0 });
    expect(obj(allocateConstrained({ assets: [...xs].reverse() }).weightsBps)).toEqual(first);
  });

  it('a single asset must take everything', () => {
    expect(obj(allocateConstrained({ assets: [asset('only', 1, 0, 10_000)] }).weightsBps)).toEqual({
      only: 10_000,
    });
  });

  it('yield floors toward negative infinity: an exact -1 wei weighted yield stays -1 (floor)', () => {
    const r = allocateConstrained({
      assets: [{ id: 'x', minBps: 0, maxBps: 10_000, estimatedYieldWad: -1n }],
    });
    expect(r.estimatedPortfolioYield.wad).toBe(-1n);
  });
});

describe('allocateConstrained: infeasible and invalid inputs', () => {
  it('minimums above 100%', () => {
    expect(() =>
      allocateConstrained({ assets: [asset('a', 1, 6000, 10_000), asset('b', 1, 5000, 10_000)] }),
    ).toThrow(InfeasibleAllocationError);
  });
  it('maximums that cannot reach 100%', () => {
    expect(() =>
      allocateConstrained({ assets: [asset('a', 1, 0, 4000), asset('b', 1, 0, 5000)] }),
    ).toThrow('short by 1000');
  });
  it('group minimums above the group cap', () => {
    expect(() =>
      allocateConstrained({
        assets: [asset('a', 1, 3000, 10_000, 'g')],
        groupCaps: [{ group: 'g', maxBps: 2000 }],
      }),
    ).toThrow('exceed its cap');
  });
  it('group caps that make 100% unreachable', () => {
    expect(() =>
      allocateConstrained({
        assets: [asset('a', 1, 0, 10_000, 'g'), asset('b', 1, 0, 3000)],
        groupCaps: [{ group: 'g', maxBps: 5000 }],
      }),
    ).toThrow(InfeasibleAllocationError);
  });
  it('malformed inputs', () => {
    expect(() => allocateConstrained({ assets: [] })).toThrow(RangeError);
    expect(() =>
      allocateConstrained({ assets: [asset('a', 1, 0, 10_000), asset('a', 1, 0, 10_000)] }),
    ).toThrow('duplicate asset');
    expect(() => allocateConstrained({ assets: [asset('a', 1, 5000, 4000)] })).toThrow(
      'minBps > maxBps',
    );
    expect(() => allocateConstrained({ assets: [asset('a', 1, 0, 10_001)] })).toThrow(RangeError);
    expect(() => allocateConstrained({ assets: [asset('a', 1, 0.5, 10_000)] })).toThrow(RangeError);
    expect(() => allocateConstrained({ assets: [asset('a', 1, 0, 10_000, 'ghost')] })).toThrow(
      'without a cap',
    );
    expect(() =>
      allocateConstrained({
        assets: [asset('a', 1, 0, 10_000, 'g')],
        groupCaps: [
          { group: 'g', maxBps: 1 },
          { group: 'g', maxBps: 2 },
        ],
      }),
    ).toThrow('duplicate cap');
  });
});

/** Exhaustive search over weights that are multiples of `step` bps; used as an independent oracle. */
function bruteForce(
  assets: readonly AllocationAsset[],
  caps: readonly GroupCap[],
  step: number,
): bigint | null {
  const units = 10_000 / step;
  const capOf = new Map(caps.map((c) => [c.group, c.maxBps]));
  let best: bigint | null = null;
  const w: number[] = [];
  const rec = (i: number, left: number): void => {
    if (i === assets.length) {
      if (left !== 0) return;
      const used = new Map<string, number>();
      for (let k = 0; k < assets.length; k += 1) {
        const g = assets[k]!.group;
        if (g !== undefined) used.set(g, (used.get(g) ?? 0) + w[k]! * step);
      }
      for (const [g, u] of used) if (u > capOf.get(g)!) return;
      let y = 0n;
      for (let k = 0; k < assets.length; k += 1)
        y += BigInt(w[k]! * step) * assets[k]!.estimatedYieldWad;
      if (best === null || y > best) best = y;
      return;
    }
    const a = assets[i]!;
    for (
      let u = Math.ceil(a.minBps / step);
      u <= Math.min(Math.floor(a.maxBps / step), left);
      u += 1
    ) {
      w[i] = u;
      rec(i + 1, left - u);
    }
  };
  rec(0, units);
  return best;
}

function gridInstance(g: Gen): { assets: AllocationAsset[]; caps: GroupCap[] } {
  const n = g.int(2, 4);
  const groups = ['g1', 'g2'];
  const assets = Array.from({ length: n }, (_, i): AllocationAsset => {
    const lo = g.int(0, 4) * 1000;
    const hi = Math.min(10_000, lo + g.int(0, 10) * 1000);
    const grp = g.pick([undefined, 'g1', 'g2'] as const);
    return {
      id: `a${i}`,
      minBps: lo,
      maxBps: hi,
      estimatedYieldWad: BigInt(g.int(-5, 15)) * 10n ** 16n,
      ...(grp === undefined ? {} : { group: grp }),
    };
  });
  const caps = groups
    .filter((gr) => assets.some((a) => a.group === gr))
    .map((gr) => ({ group: gr, maxBps: g.int(0, 10) * 1000 }));
  return { assets, caps };
}

describe('allocateConstrained: properties', () => {
  it('matches exhaustive search on 1000-bps grids, and is infeasible exactly when no grid point exists', () => {
    forAll({ runs: 400 }, gridInstance, ({ assets, caps }) => {
      const oracle = bruteForce(assets, caps, 1000);
      let result: ReturnType<typeof allocateConstrained> | null = null;
      try {
        result = allocateConstrained({ assets, groupCaps: caps });
      } catch (e) {
        expect(e instanceof InfeasibleAllocationError).toBe(true);
      }
      if (oracle === null) {
        expect(result).toBeNull();
        return;
      }
      expect(result).not.toBeNull();
      // objective compared at full precision (Σ w·y, no division) so the check is exact
      let y = 0n;
      for (const a of assets) y += BigInt(result!.weightsBps.get(a.id)!) * a.estimatedYieldWad;
      expect(y).toBe(oracle);
    });
  });

  it('every output satisfies every constraint and sums to exactly 10,000', () => {
    forAll({ runs: 400 }, gridInstance, ({ assets, caps }) => {
      let r;
      try {
        r = allocateConstrained({ assets, groupCaps: caps });
      } catch {
        return;
      }
      let sum = 0;
      const used = new Map<string, number>();
      for (const a of assets) {
        const w = r.weightsBps.get(a.id)!;
        expect(w >= a.minBps && w <= a.maxBps).toBe(true);
        expect(Number.isInteger(w)).toBe(true);
        sum += w;
        if (a.group !== undefined) used.set(a.group, (used.get(a.group) ?? 0) + w);
      }
      expect(sum).toBe(10_000);
      for (const c of caps) expect((used.get(c.group) ?? 0) <= c.maxBps).toBe(true);
    });
  });

  it('is invariant to input order', () => {
    forAll(
      { runs: 200 },
      (g) => ({ inst: gridInstance(g), seed: g.int(1, 1e6) }),
      ({ inst, seed }) => {
        let a;
        try {
          a = allocateConstrained({ assets: inst.assets, groupCaps: inst.caps });
        } catch {
          return;
        }
        const rotated = [
          ...inst.assets.slice(seed % inst.assets.length),
          ...inst.assets.slice(0, seed % inst.assets.length),
        ];
        expect(
          obj(allocateConstrained({ assets: rotated, groupCaps: inst.caps }).weightsBps),
        ).toEqual(obj(a.weightsBps));
      },
    );
  });
});

describe('weightsToAmounts: largest remainder, no unit created or lost', () => {
  it('hand-computed: 100 units over thirds', () => {
    const m = weightsToAmounts(
      100n,
      new Map([
        ['a', 3334],
        ['b', 3333],
        ['c', 3333],
      ]),
    );
    expect(obj(m)).toEqual({ a: 34n, b: 33n, c: 33n });
  });
  it('the largest fractional remainder wins the leftover unit, not the smallest id', () => {
    // 7 units: a 4.2, b 2.1, c 0.7 -> floors 4,2,0 (sum 6); the spare unit goes to c (remainder .7)
    expect(
      obj(
        weightsToAmounts(
          7n,
          new Map([
            ['a', 6000],
            ['b', 3000],
            ['c', 1000],
          ]),
        ),
      ),
    ).toEqual({ a: 4n, b: 2n, c: 1n });
  });
  it('remainder ties go to the smaller id: 1 unit over 50/50 is given to "a"', () => {
    expect(
      obj(
        weightsToAmounts(
          1n,
          new Map([
            ['b', 5000],
            ['a', 5000],
          ]),
        ),
      ),
    ).toEqual({ a: 1n, b: 0n });
  });
  it('zero total and rejection of bad inputs', () => {
    expect(obj(weightsToAmounts(0n, new Map([['a', 10_000]])))).toEqual({ a: 0n });
    expect(() => weightsToAmounts(-1n, new Map([['a', 10_000]]))).toThrow(RangeError);
    expect(() => weightsToAmounts(10n, new Map([['a', 9999]]))).toThrow('10000');
  });
  it('property: sums exactly to total and each share is within one unit of the exact proportion', () => {
    forAll(
      {},
      (g) => {
        const n = g.int(1, 6);
        const cuts = Array.from({ length: n - 1 }, () => g.int(0, 10_000)).sort((x, y) => x - y);
        const ws = [...cuts, 10_000].map((c, i) => c - (i === 0 ? 0 : cuts[i - 1]!));
        return { total: g.bigBiased(0n, 10n ** 30n), ws };
      },
      ({ total, ws }) => {
        const out = weightsToAmounts(total, new Map(ws.map((w, i) => [`k${i}`, w])));
        let s = 0n;
        ws.forEach((w, i) => {
          const v = out.get(`k${i}`)!;
          s += v;
          const exactFloor = (total * BigInt(w)) / 10_000n;
          expect(v === exactFloor || v === exactFloor + 1n).toBe(true);
        });
        expect(s).toBe(total);
      },
    );
  });
});

describe('turnover', () => {
  const cur = new Map([
    ['a', 6000],
    ['b', 4000],
  ]);
  const tgt = new Map([
    ['a', 2000],
    ['b', 8000],
  ]);
  it('turnoverBps is half the sum of absolute changes', () => {
    expect(turnoverBps(cur, tgt)).toBe(4000);
    expect(turnoverBps(cur, cur)).toBe(0);
    expect(turnoverBps(new Map([['a', 10_000]]), new Map([['b', 10_000]]))).toBe(10_000); // disjoint assets
  });
  it('returns the target when it is within the limit', () => {
    expect(obj(limitTurnover({ current: cur, target: tgt, maxTurnoverBps: 4000 }))).toEqual({
      a: 2000,
      b: 8000,
    });
    expect(obj(limitTurnover({ current: cur, target: tgt, maxTurnoverBps: 10_000 }))).toEqual({
      a: 2000,
      b: 8000,
    });
  });
  it('hand-computed: a 1000 bps limit moves a quarter of the way', () => {
    expect(obj(limitTurnover({ current: cur, target: tgt, maxTurnoverBps: 1000 }))).toEqual({
      a: 5000,
      b: 5000,
    });
  });
  it('zero limit means no trades', () => {
    expect(obj(limitTurnover({ current: cur, target: tgt, maxTurnoverBps: 0 }))).toEqual({
      a: 6000,
      b: 4000,
    });
  });
  it('rejects portfolios that do not sum to 100%', () => {
    expect(() =>
      limitTurnover({ current: new Map([['a', 9000]]), target: tgt, maxTurnoverBps: 100 }),
    ).toThrow('10000');
  });

  function randomWeights(g: Gen, ids: string[]): Map<string, number> {
    const cuts = Array.from({ length: ids.length - 1 }, () => g.int(0, 10_000)).sort(
      (x, y) => x - y,
    );
    const parts = [...cuts, 10_000].map((c, i) => c - (i === 0 ? 0 : cuts[i - 1]!));
    return new Map(ids.map((id, i) => [id, parts[i]!]));
  }
  it('property: sums to 10,000, stays between current and target, never exceeds the limit', () => {
    forAll(
      { runs: 600 },
      (g) => {
        const ids = ['a', 'b', 'c', 'd', 'e'].slice(0, g.int(2, 5));
        return {
          current: randomWeights(g, ids),
          target: randomWeights(g, ids),
          max: g.pick([0, 1, 7, 100, 999, 2500, g.int(0, 10_000)]),
        };
      },
      ({ current, target, max }) => {
        const out = limitTurnover({ current, target, maxTurnoverBps: max });
        let sum = 0;
        for (const [id, w] of out) {
          sum += w;
          const lo = Math.min(current.get(id)!, target.get(id)!);
          const hi = Math.max(current.get(id)!, target.get(id)!);
          expect(w >= lo && w <= hi).toBe(true);
          expect(Number.isInteger(w)).toBe(true);
        }
        expect(sum).toBe(10_000);
        expect(turnoverBps(current, out) <= max).toBe(true);
        if (turnoverBps(current, target) <= max) expect(obj(out)).toEqual(obj(target));
      },
    );
  });
  it('property: the limit is used (turnover within rounding of the limit when the target is further away)', () => {
    forAll(
      { runs: 300 },
      (g) => {
        const ids = ['a', 'b', 'c'];
        return {
          current: randomWeights(g, ids),
          target: randomWeights(g, ids),
          max: g.int(1, 5000),
        };
      },
      ({ current, target, max }) => {
        if (turnoverBps(current, target) <= max) return;
        const out = limitTurnover({ current, target, maxTurnoverBps: max });
        // rounding toward current can only lose a few bps (at most one per asset)
        expect(turnoverBps(current, out) >= max - 3).toBe(true);
      },
    );
  });
});
