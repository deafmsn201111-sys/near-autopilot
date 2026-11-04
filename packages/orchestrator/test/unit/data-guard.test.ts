import { describe, expect, it } from 'vitest';
import { checkDataQuality } from '../../src';
import { ALICE, NOW, USDT, WNEAR, makeWorld } from '../support/world';

const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const run = (
  w: ReturnType<typeof makeWorld>,
  over: Partial<Parameters<typeof checkDataQuality>[0]> = {},
) =>
  checkDataQuality({
    now: NOW,
    expectedAccount: ALICE,
    snapshot: w.buildSnapshot(),
    market: w.buildMarket(),
    config: w.config,
    ...over,
  });
const codes = (q: ReturnType<typeof run>) => q.issues.map((i) => i.code);
const withSnap = (w: ReturnType<typeof makeWorld>, patch: object) => ({
  ...w.buildSnapshot(),
  ...patch,
});

describe('checkDataQuality', () => {
  it('fresh and complete -> clean', () => {
    const q = run(makeWorld());
    expect(q).toMatchObject({ issues: [], blocking: false, marketUsable: true });
  });

  it('age limits are inclusive at the limit and blocking one millisecond past it', () => {
    const w = makeWorld();
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    expect(run(w, { snapshot: withSnap(w, { takenAt: at(60_000) }) }).blocking).toBe(false);
    expect(codes(run(w, { snapshot: withSnap(w, { takenAt: at(60_001) }) }))).toEqual([
      'SNAPSHOT_STALE',
    ]);
    expect(run(w, { snapshot: withSnap(w, { pricesAsOf: at(60_000) }) }).blocking).toBe(false);
    expect(codes(run(w, { snapshot: withSnap(w, { pricesAsOf: at(60_001) }) }))).toEqual([
      'PRICES_STALE',
    ]);
  });

  it('future timestamps beyond the skew allowance are blocking; within it they are tolerated', () => {
    const w = makeWorld();
    const skew = w.config.freshness.maxFutureSkewSeconds;
    expect(run(w, { snapshot: withSnap(w, { takenAt: ago(-skew) }) }).blocking).toBe(false);
    expect(codes(run(w, { snapshot: withSnap(w, { takenAt: ago(-skew - 1) }) }))).toEqual([
      'FUTURE_TIMESTAMP',
    ]);
  });

  it('invalid dates are blocking, not "fresh"', () => {
    const w = makeWorld();
    const q = run(w, {
      snapshot: withSnap(w, { takenAt: new Date('nope'), pricesAsOf: new Date(NaN) }),
    });
    expect(q.blocking).toBe(true);
    expect(codes(q)).toEqual(['SNAPSHOT_STALE', 'PRICES_STALE']);
  });

  it('no snapshot -> blocking; wrong account -> blocking', () => {
    const w = makeWorld();
    expect(codes(run(w, { snapshot: null }))).toContain('SNAPSHOT_UNAVAILABLE');
    expect(run(w, { snapshot: null }).blocking).toBe(true);
    expect(codes(run(w, { snapshot: withSnap(w, { accountId: 'bob.near' }) }))).toEqual([
      'ACCOUNT_MISMATCH',
    ]);
  });

  it('missing prices or risk parameters block only when a borrow is open', () => {
    const borrowing = makeWorld({ lending: { collateralNear: 100, debtUsdt: 100 } });
    const snap = borrowing.buildSnapshot();
    const noPrice = new Map(snap.prices);
    noPrice.delete(USDT);
    const noRisk = new Map(snap.risk);
    noRisk.delete(WNEAR);
    const p = run(borrowing, { snapshot: { ...snap, prices: noPrice } });
    expect(codes(p)).toEqual(['MISSING_PRICES']);
    expect(p.blocking).toBe(true);
    const r = run(borrowing, { snapshot: { ...snap, risk: noRisk } });
    expect(codes(r)).toEqual(['MISSING_RISK_PARAMS']);
    expect(r.blocking).toBe(true);

    const idle = makeWorld({ lending: null });
    const s2 = idle.buildSnapshot();
    const p2 = new Map(s2.prices);
    p2.delete(USDT);
    expect(run(idle, { snapshot: { ...s2, prices: p2 } }).blocking).toBe(false);
  });

  it('market problems are never blocking, but they make the market unusable', () => {
    const w = makeWorld();
    const stale = run(w, {
      market: { ...w.buildMarket(), asOf: ago(w.config.freshness.maxMarketAgeSeconds + 1) },
    });
    expect(stale).toMatchObject({ blocking: false, marketUsable: false });
    expect(codes(stale)).toEqual(['MARKET_STALE']);
    const none = run(w, { market: null });
    expect(none).toMatchObject({ blocking: false, marketUsable: false });
    expect(codes(none)).toEqual(['MARKET_UNAVAILABLE']);
    const future = run(w, { market: { ...w.buildMarket(), asOf: ago(-3600) } });
    expect(future.marketUsable).toBe(false);
  });

  it('market usability is false whenever the snapshot is blocking', () => {
    const w = makeWorld();
    expect(run(w, { snapshot: null }).marketUsable).toBe(false);
  });

  it('is a pure function of its arguments (the clock is a parameter)', () => {
    const w = makeWorld();
    const a = run(w);
    const b = run(w);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const later = checkDataQuality({
      now: new Date(NOW.getTime() + 61_000),
      expectedAccount: ALICE,
      snapshot: w.buildSnapshot(),
      market: w.buildMarket(),
      config: w.config,
    });
    expect(later.blocking).toBe(true);
  });
});
