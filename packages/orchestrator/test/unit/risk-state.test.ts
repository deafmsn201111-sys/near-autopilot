import { describe, expect, it } from 'vitest';
import {
  WAD,
  afterRepay,
  afterSupply,
  assessRisk,
  buildLendingModel,
  hfOrInfinity,
  smallestAmountReaching,
  targetHfWad,
} from '../../src';
import { USDT, WNEAR, makeWorld, near, usdt } from '../support/world';

const level = (debt: number | null, collateral = 100) => {
  const w = makeWorld({
    lending: debt === null ? null : { collateralNear: collateral, debtUsdt: debt },
  });
  return assessRisk(w.buildSnapshot(), w.config);
};

describe('assessRisk', () => {
  it('matches the hand-computed health factor: HF = (collateral*price*cf) / (debt/bf)', () => {
    // 100 NEAR * $5 * 0.7 = $350 ; 230 USDT / 0.9 = $255.555... ; HF = 1.36956521...
    const r = level(230);
    expect(r.healthFactorWad).toBe(1_369_565_215_009_451_799n);
    expect(r.level).toBe('watch');
    expect(r.ltvBps).toBe(4600n);
  });

  it('classifies every band, with the boundaries going to the safer side', () => {
    const expected: [number | null, string][] = [
      [null, 'none'],
      [100, 'healthy'],
      [205, 'healthy'],
      [230, 'watch'],
      [290, 'danger'],
      [305, 'critical'],
      [330, 'liquidatable'],
    ];
    for (const [debt, lvl] of expected) expect([debt, level(debt).level]).toEqual([debt, lvl]);
  });

  it('an unpriced position is "unknown", never healthy', () => {
    const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 100 } });
    const snap = w.buildSnapshot();
    const prices = new Map(snap.prices);
    prices.delete(USDT);
    const r = assessRisk({ ...snap, prices }, w.config);
    expect(r.level).toBe('unknown');
    expect(r.healthFactorWad).toBeNull();
    expect(r.note).toContain(USDT);
  });

  it('includes the configured stress scenarios', () => {
    expect(level(230).stress.length).toBeGreaterThan(0);
  });

  it('more debt never improves risk; more collateral never worsens it', () => {
    let prev = Infinity;
    for (let debt = 50; debt <= 340; debt += 10) {
      const hf = Number(level(debt).healthFactorWad! / 10n ** 12n);
      expect(hf <= prev).toBe(true);
      prev = hf;
    }
    prev = 0;
    for (let c = 50; c <= 200; c += 10) {
      const hf = Number(level(230, c).healthFactorWad! / 10n ** 12n);
      expect(hf >= prev).toBe(true);
      prev = hf;
    }
  });
});

describe('model transformations', () => {
  const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 230 } });
  const model = (() => {
    const b = buildLendingModel(w.buildSnapshot());
    if (!b.ok) throw new Error('model');
    return b.model;
  })();

  it('afterRepay reduces exactly the right debt and does not mutate the original', () => {
    const next = afterRepay(model, USDT, usdt(30));
    expect(next.debt[0]!.amount).toBe(usdt(200));
    expect(model.debt[0]!.amount).toBe(usdt(230));
  });

  it('repaying more than is owed floors at zero', () => {
    expect(afterRepay(model, USDT, usdt(9999)).debt.every((d) => d.amount === 0n)).toBe(true);
  });

  it('afterSupply adds to an existing collateral line or creates a new one; ineligible tokens give null', () => {
    const more = afterSupply(model, w.buildSnapshot(), WNEAR, near(10));
    expect(more?.collateral.find((c) => c.id === WNEAR)?.amount).toBe(near(110));
    const fresh = afterSupply(model, w.buildSnapshot(), USDT, usdt(100));
    expect(fresh?.collateral.map((c) => c.id).sort()).toEqual([USDT, WNEAR].sort());
    expect(afterSupply(model, w.buildSnapshot(), 'unknown.near' as typeof USDT, 1n)).toBeNull();
  });

  it('buildLendingModel lists what is missing rather than guessing', () => {
    const snap = w.buildSnapshot();
    const prices = new Map(snap.prices);
    prices.delete(WNEAR);
    const r = buildLendingModel({ ...snap, prices });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.missing).toEqual([`price:${WNEAR}`]);
  });
});

describe('smallestAmountReaching (bisection on a monotone function)', () => {
  const linear = (a: bigint) => 1000n + a * 10n; // reaches target T at a >= (T-1000)/10

  it('finds the exact threshold', () => {
    expect(smallestAmountReaching(10_000n, 2000n, linear)).toBe(100n);
    expect(linear(99n) < 2000n && linear(100n) >= 2000n).toBe(true);
  });

  it('returns max when even max falls short, and 0 for a non-positive max', () => {
    expect(smallestAmountReaching(50n, 2000n, linear)).toBe(50n);
    expect(smallestAmountReaching(0n, 2000n, linear)).toBe(0n);
    expect(smallestAmountReaching(-5n, 2000n, linear)).toBe(0n);
  });

  it('works when the target is reached at exactly 1 and at exactly max', () => {
    expect(smallestAmountReaching(1000n, 1010n, linear)).toBe(1n);
    expect(smallestAmountReaching(100n, 2000n, linear)).toBe(100n);
  });

  it('treats "no debt" (null) as infinitely healthy', () => {
    expect(hfOrInfinity(null) > 10n ** 60n).toBe(true);
    expect(smallestAmountReaching(1000n, 2n * WAD, () => null)).toBe(1n);
  });

  it('target health factor comes from configuration', () => {
    expect(targetHfWad(makeWorld().config)).toBe(1_600_000_000_000_000_000n);
  });
});
