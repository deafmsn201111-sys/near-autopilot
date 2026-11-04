import { describe, expect, it } from 'vitest';
import { toJsonSafe } from '@near-autopilot/core';
import { decide, type RecentAction } from '../../src';
import { NOW, USDT, WNEAR, makeWorld, near, usdt } from '../support/world';
import { buildInput, prop } from '../support/inputs';

const repay = (amount: bigint) =>
  prop('liquidation-guardian', { kind: 'lending.repay', token: USDT, amount, rationale: 'r' });
const supply = (amount: bigint) =>
  prop('liquidation-guardian', {
    kind: 'lending.supply_collateral',
    token: USDT,
    amount,
    rationale: 'r',
  });
const swap = (amountIn: bigint, over: Record<string, unknown> = {}) =>
  prop('capital-allocator', {
    kind: 'allocation.swap',
    tokenIn: WNEAR,
    tokenOut: USDT,
    amountIn,
    maxSlippageBps: 50,
    rationale: 'r',
    ...over,
  });
const noAction = (agent: 'market-intelligence' | 'capital-allocator' = 'capital-allocator') =>
  prop(agent, { kind: 'no_action', reasonCode: 'no_edge', rationale: 'r' });
const signal = (severity: number, validUntil = new Date(NOW.getTime() + 60_000)) =>
  prop('market-intelligence', {
    kind: 'market.signal',
    token: WNEAR,
    signal: 'volatility_spike',
    severity,
    validUntil,
    rationale: 'r',
  });

const watch = { collateralNear: 100, debtUsdt: 230 };
const fairQuote = (
  p: ReturnType<typeof swap>,
  amountOutUsdt = 49.7,
): Map<string, { poolId: number; amountIn: bigint; amountOut: bigint } | null> =>
  new Map([
    [
      p.proposalId,
      {
        poolId: 7,
        amountIn: (p.proposal as { amountIn: bigint }).amountIn,
        amountOut: usdt(amountOutUsdt),
      },
    ],
  ]);
const snapshotOf = (world: ReturnType<typeof makeWorld>) => world.buildSnapshot();
const json = (x: unknown): string => JSON.stringify(toJsonSafe(x));

describe('decide: preconditions and modes', () => {
  it('blocking data quality -> no action whatever is proposed', () => {
    const w = makeWorld({ lending: watch, snapshotAgeSeconds: 600 });
    const d = decide(buildInput([repay(usdt(30))], w));
    expect(d.outcome).toBe('no_action');
    expect(d.reasons).toEqual(['DATA_NOT_FRESH']);
    expect(d.ranked).toHaveLength(0);
  });

  it('nothing proposed -> NOTHING_PROPOSED', () => {
    const d = decide(buildInput([noAction()], makeWorld()));
    expect(d.reasons).toEqual(['NOTHING_PROPOSED']);
    expect(d.agentNoActions).toEqual([{ agent: 'capital-allocator', reasonCode: 'no_edge' }]);
  });

  it('read_only: the engine still evaluates (so the human can see what was suppressed) but outputs no executable candidate', () => {
    const w = makeWorld({ lending: watch });
    const d = decide(buildInput([repay(usdt(30))], w, { persistedMode: 'read_only' }));
    expect(d.outcome).toBe('no_action');
    expect(d.reasons).toEqual(['READ_ONLY_MODE']);
    expect(d.ranked).toHaveLength(0);
    expect(d.wouldHaveActed?.action.kind).toBe('lending.repay');
  });

  it('risk_reduction_only: de-risking passes, discretionary swaps do not', () => {
    const calm = makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });
    const s = swap(near(10));
    const d = decide(
      buildInput([s], calm, { persistedMode: 'risk_reduction_only', quotes: fairQuote(s) }),
    );
    expect(d.rejected.map((r) => r.code)).toEqual(['MODE_RISK_REDUCTION_ONLY']);
    const w = makeWorld({ lending: watch });
    const d2 = decide(buildInput([repay(usdt(30))], w, { persistedMode: 'risk_reduction_only' }));
    expect(d2.outcome).toBe('act');
  });

  it('the effective mode is tightened by danger risk but a looser persisted mode is never what the engine uses', () => {
    const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 290 } });
    const d = decide(buildInput([repay(usdt(60))], w));
    expect(d.mode).toMatchObject({ persisted: 'normal', effective: 'risk_reduction_only' });
    const d2 = decide(buildInput([repay(usdt(60))], w, { persistedMode: 'read_only' }));
    expect(d2.mode.effective).toBe('read_only');
  });

  it('quarantined agents’ proposals are discarded', () => {
    const w = makeWorld({ lending: watch });
    const d = decide(
      buildInput([repay(usdt(30))], w, { quarantined: new Set(['liquidation-guardian']) }),
    );
    expect(d.ranked).toHaveLength(0);
    expect(d.rejected.map((r) => r.code)).toEqual(['AGENT_QUARANTINED']);
  });
});

describe('decide: lending risk reduction', () => {
  it('repay is justified only when the ENGINE finds the position at watch or worse', () => {
    const healthy = decide(
      buildInput([repay(usdt(30))], makeWorld({ lending: { collateralNear: 100, debtUsdt: 100 } })),
    );
    expect(healthy.rejected.map((r) => r.code)).toEqual(['NOT_JUSTIFIED']);
    const noDebt = decide(buildInput([repay(usdt(30))], makeWorld({ lending: null })));
    expect(noDebt.rejected.map((r) => r.code)).toEqual(['NOT_JUSTIFIED']);
    const watching = decide(buildInput([repay(usdt(30))], makeWorld({ lending: watch })));
    expect(watching.outcome).toBe('act');
  });

  it('size is the smallest amount that reaches the target health factor, however large the request', () => {
    const w = makeWorld({ lending: watch });
    const d = decide(buildInput([repay(usdt(400))], w));
    const c = d.ranked[0];
    expect(c?.action).toMatchObject({ kind: 'lending.repay', amount: 33_125_000n });
    expect(c?.sizing).toEqual({ requested: usdt(400), final: 33_125_000n });
    // One unit less would not reach the target.
    expect(c?.riskEffect?.hfAfterWad).toBeGreaterThanOrEqual(1_600_000_000_000_000_000n);
  });

  it('size is capped by the wallet: a partial improvement is accepted', () => {
    const w = makeWorld({ lending: watch, wallet: { near: 100, usdt: 10 } });
    const c = decide(buildInput([repay(usdt(400))], w)).ranked[0];
    expect(c?.action).toMatchObject({ amount: usdt(10) });
    expect(c?.riskEffect && c.riskEffect.hfAfterWad! > c.riskEffect.hfBeforeWad!).toBe(true);
    expect(c?.riskEffect && c.riskEffect.hfAfterWad! < 1_600_000_000_000_000_000n).toBe(true);
  });

  it('an empty wallet gives INSUFFICIENT_BALANCE, not a zero-sized action', () => {
    const w = makeWorld({ lending: watch, wallet: { near: 0, usdt: 0 } });
    const d = decide(buildInput([repay(usdt(30))], w));
    expect(d.rejected.map((r) => r.code)).toEqual(['INSUFFICIENT_BALANCE']);
  });

  it('repaying a token that is not borrowed is refused', () => {
    const d = decide(
      buildInput(
        [
          prop('liquidation-guardian', {
            kind: 'lending.repay',
            token: WNEAR,
            amount: near(1),
            rationale: 'r',
          }),
        ],
        makeWorld({ lending: watch }),
      ),
    );
    expect(d.rejected.map((r) => r.code)).toEqual(['NO_DEBT_FOR_TOKEN']);
  });

  it('collateral must be an eligible, priced token', () => {
    const w = makeWorld({ lending: watch });
    const snap = snapshotOf(w);
    const risk = new Map(snap.risk);
    risk.set(USDT, { ...risk.get(USDT)!, canBeCollateral: false });
    const d = decide(buildInput([supply(usdt(100))], w, { snapshot: { ...snap, risk } }));
    expect(d.rejected.map((r) => r.code)).toEqual(['NOT_COLLATERAL_ELIGIBLE']);
  });

  it('with both repay and top-up available, the cheaper effective de-risk ranks first; both are tier 1 at watch', () => {
    const d = decide(
      buildInput([supply(usdt(400)), repay(usdt(400))], makeWorld({ lending: watch })),
    );
    expect(d.ranked.map((c) => c.action.kind)).toEqual([
      'lending.repay',
      'lending.supply_collateral',
    ]);
    expect(d.ranked.map((c) => c.tier)).toEqual([1, 1]);
  });

  it('tier 0 once the position is in danger', () => {
    const d = decide(
      buildInput(
        [repay(usdt(400))],
        makeWorld({ lending: { collateralNear: 100, debtUsdt: 290 } }),
      ),
    );
    expect(d.ranked[0]?.tier).toBe(0);
  });

  it('every de-risk candidate strictly improves the health factor', () => {
    for (const debt of [205, 230, 260, 290, 305, 320]) {
      const d = decide(
        buildInput(
          [repay(usdt(400)), supply(usdt(400))],
          makeWorld({ lending: { collateralNear: 100, debtUsdt: debt } }),
        ),
      );
      for (const c of d.ranked)
        expect(c.riskEffect!.hfAfterWad! > c.riskEffect!.hfBeforeWad!).toBe(true);
    }
  });
});

describe('decide: swaps (discretionary)', () => {
  const calm = () => makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });

  it('a swap with a real estimated edge becomes a tier-2 candidate with an ESTIMATED, engine-computed benefit', () => {
    const s = swap(near(10));
    const d = decide(buildInput([s], calm(), { quotes: fairQuote(s) }));
    const c = d.ranked[0];
    expect(d.outcome).toBe('act');
    expect(c?.tier).toBe(2);
    expect(c?.basis).toBe('estimated');
    expect(c?.netBenefitUsdMicro).toBe(
      (c?.economics?.benefitUsdMicro ?? 0n) - (c?.economics?.costUsdMicro ?? 0n),
    );
    expect(c?.netBenefitUsdMicro! > 0n).toBe(true);
  });

  it('minAmountOut is derived from the QUOTE and the slippage the engine allows, never taken from the agent', () => {
    const s = swap(near(10), { maxSlippageBps: 50 });
    const c = decide(buildInput([s], calm(), { quotes: fairQuote(s, 49.7) })).ranked[0];
    expect(c?.action.kind).toBe('allocation.swap');
    if (c?.action.kind === 'allocation.swap') {
      expect(c.action.quotedAmountOut).toBe(usdt(49.7));
      expect(c.action.minAmountOut).toBe((usdt(49.7) * 9950n) / 10_000n);
      expect(c.action.poolId).toBe(7);
    }
  });

  const rejectsWith = (
    code: string,
    s: ReturnType<typeof swap>,
    w = calm(),
    quotes?: ReturnType<typeof fairQuote>,
    over = {},
  ) => {
    const d = decide(buildInput([s], w, { quotes: quotes ?? fairQuote(s), ...over }));
    expect(d.rejected.map((r) => r.code)).toEqual([code]);
    expect(d.ranked).toHaveLength(0);
  };

  it('every guard rejects with its own code', () => {
    rejectsWith('NO_QUOTE', swap(near(10)), calm(), new Map());
    const s = swap(near(10));
    rejectsWith('NO_QUOTE', s, calm(), new Map([[s.proposalId, null]]));
    rejectsWith('SAME_TOKEN', swap(near(10), { tokenOut: WNEAR }));
    rejectsWith('SLIPPAGE_ABOVE_LIMIT', swap(near(10), { maxSlippageBps: 500 }));
    rejectsWith('EXCEEDS_ORCHESTRATOR_LIMIT', swap(near(30)));
    rejectsWith('INSUFFICIENT_BALANCE', swap(near(1000)));
    rejectsWith('NO_PRICE', swap(near(10), { tokenOut: 'scam.near' }));
    const worse = swap(near(10));
    rejectsWith('QUOTE_WORSE_THAN_ORACLE', worse, calm(), fairQuote(worse, 40));
  });

  it('a quote for a DIFFERENT amount than the one proposed is not usable', () => {
    const s = swap(near(10));
    const wrong = new Map([
      [s.proposalId, { poolId: 7, amountIn: near(5), amountOut: usdt(24.8) }],
    ]);
    const d = decide(buildInput([s], calm(), { quotes: wrong }));
    expect(d.rejected.map((r) => r.code)).toEqual(['NO_QUOTE']);
  });

  it('no yield estimate -> no discretionary trade', () => {
    const s = swap(near(10));
    const w = calm();
    const market = { ...w.buildMarket(), estimatedYieldWad: new Map() };
    const d = decide(buildInput([s], w, { quotes: fairQuote(s), market }));
    expect(d.rejected.map((r) => r.code)).toEqual(['NO_YIELD_ESTIMATE']);
  });

  it('stale market data -> MARKET_DATA_STALE; missing market -> same', () => {
    const s = swap(near(10));
    const w = calm();
    const stale = { ...w.buildMarket(), asOf: new Date(NOW.getTime() - 3_600_000) };
    expect(
      decide(buildInput([s], w, { quotes: fairQuote(s), market: stale })).rejected.map(
        (r) => r.code,
      ),
    ).toEqual(['MARKET_DATA_STALE']);
    expect(
      decide(buildInput([s], w, { quotes: fairQuote(s), market: null })).rejected.map(
        (r) => r.code,
      ),
    ).toEqual(['MARKET_DATA_STALE']);
  });

  it('a position at watch or worse blocks every discretionary trade', () => {
    const s = swap(near(10));
    const w = makeWorld({ lending: watch, yields: { near: 2, usdt: 40 } });
    expect(
      decide(buildInput([s], w, { quotes: fairQuote(s) })).rejected.map((r) => r.code),
    ).toEqual(['RISK_NOT_HEALTHY']);
  });

  it('a benefit that does not clear the hurdle is rejected', () => {
    const s = swap(near(10));
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 5 } });
    expect(
      decide(buildInput([s], w, { quotes: fairQuote(s) })).rejected.map((r) => r.code),
    ).toEqual(['BELOW_HURDLE']);
  });

  it('market signals: severity >= 4 defers swaps; an expired signal does nothing; signals never create candidates', () => {
    const s = swap(near(10));
    const w = calm();
    const quotes = fairQuote(s);
    const plain = decide(buildInput([s], w, { quotes }));
    expect(plain.outcome).toBe('act');
    const cautious = decide(buildInput([s, signal(4)], w, { quotes }));
    expect(cautious.rejected.map((r) => r.code)).toEqual(['SIGNAL_CAUTION']);
    expect(cautious.cautions).toHaveLength(1);
    const expired = decide(buildInput([s, signal(5, new Date(NOW.getTime() - 1))], w, { quotes }));
    expect(expired.outcome).toBe('act');
    const onlySignal = decide(buildInput([signal(5)], w));
    expect(onlySignal.outcome).toBe('no_action');
    expect(onlySignal.ranked).toHaveLength(0);
  });

  it('a QUARANTINED agent’s signals are ignored too (a compromised feed must not be able to freeze trading indefinitely)', () => {
    const s = swap(near(10));
    const w = calm();
    const quotes = fairQuote(s);
    expect(decide(buildInput([s, signal(5)], w, { quotes })).outcome).toBe('no_action');
    const d = decide(
      buildInput([s, signal(5)], w, { quotes, quarantined: new Set(['market-intelligence']) }),
    );
    expect(d.outcome).toBe('act');
    expect(d.cautions).toHaveLength(0);
  });

  it('a signal on a token that is not involved does not block the trade', () => {
    const s = swap(near(10));
    const other = prop('market-intelligence', {
      kind: 'market.signal',
      token: 'other.near',
      signal: 'depeg_risk',
      severity: 5,
      validUntil: new Date(NOW.getTime() + 60_000),
      rationale: 'r',
    });
    expect(decide(buildInput([s, other], calm(), { quotes: fairQuote(s) })).outcome).toBe('act');
  });
});

describe('decide: LP proposals are advisory only', () => {
  it('an unknown position or invalid range is rejected; nothing executable is ever produced', () => {
    const w = makeWorld({ lending: null });
    const d = decide(
      buildInput(
        [
          prop('lp-optimizer', {
            kind: 'lp.reposition',
            positionId: 'nope',
            tickLower: -10,
            tickUpper: 10,
            rationale: 'r',
          }),
        ],
        w,
      ),
    );
    expect(d.rejected.map((r) => r.code)).toEqual(['UNKNOWN_POSITION']);
    expect(d.ranked).toHaveLength(0);
  });
});

describe('decide: duplicate suppression', () => {
  const key = (): { world: ReturnType<typeof makeWorld>; actionKey: string } => {
    const world = makeWorld({ lending: watch });
    const first = decide(buildInput([repay(usdt(400))], world));
    return { world, actionKey: first.ranked[0]!.actionKey };
  };
  const recent = (
    actionKey: string,
    status: RecentAction['status'],
    ageSeconds: number,
    kind = 'lending.repay',
  ): RecentAction => ({ actionKey, kind, status, at: new Date(NOW.getTime() - ageSeconds * 1000) });

  it('in_flight, executed and pending_approval suppress the same action; dry_run, failed and rejected do not', () => {
    const { world, actionKey } = key();
    const snapshotBefore = {
      ...world.buildSnapshot(),
      takenAt: new Date(NOW.getTime() - 3600_000),
    };
    void snapshotBefore;
    for (const [status, suppressed] of [
      ['in_flight', true],
      ['executed', true],
      ['pending_approval', true],
      ['dry_run', false],
      ['failed', false],
      ['rejected', false],
    ] as const) {
      // pending_approval does not trigger the "awaiting fresh state" guard, so it exercises the exact-duplicate path;
      // for the others use a snapshot that is newer than the recorded action to isolate the duplicate rule.
      const snap = world.buildSnapshot();
      const d = decide(
        buildInput([repay(usdt(400))], world, {
          snapshot: snap,
          recentActions: [recent(actionKey, status, 60)],
        }),
      );
      expect([status, d.outcome === 'no_action']).toEqual([status, suppressed]);
    }
  });

  it('the window is half-open: just inside suppresses, exactly at the edge does not', () => {
    const { world, actionKey } = key();
    const w = world.config.execution.dedupeWindowSeconds;
    const snap = { ...world.buildSnapshot(), takenAt: NOW };
    const inside = decide(
      buildInput([repay(usdt(400))], world, {
        snapshot: snap,
        recentActions: [recent(actionKey, 'pending_approval', w - 1)],
      }),
    );
    const edge = decide(
      buildInput([repay(usdt(400))], world, {
        snapshot: snap,
        recentActions: [recent(actionKey, 'pending_approval', w)],
      }),
    );
    expect(inside.outcome).toBe('no_action');
    expect(inside.rejected.map((r) => r.code)).toEqual(['DUPLICATE_ACTION']);
    expect(edge.outcome).toBe('act');
  });

  it('after an executed risk reduction, further risk reductions wait for a snapshot taken AFTER it', () => {
    const w = makeWorld({ lending: watch });
    const other = recent('some-other-key', 'executed', 5); // sent 5s ago
    const snapAt = (secondsAgo: number) => ({
      ...w.buildSnapshot(),
      takenAt: new Date(NOW.getTime() - secondsAgo * 1000),
    });
    // Snapshot taken before the action: it cannot show the action's effect.
    const stale = decide(
      buildInput([repay(usdt(400)), supply(usdt(400))], w, {
        snapshot: snapAt(10),
        recentActions: [other],
      }),
    );
    expect(stale.rejected.map((r) => r.code)).toEqual([
      'AWAITING_FRESH_STATE',
      'AWAITING_FRESH_STATE',
    ]);
    // Taken at the very instant of the action: still not provably after it.
    expect(
      decide(buildInput([repay(usdt(400))], w, { snapshot: snapAt(5), recentActions: [other] }))
        .outcome,
    ).toBe('no_action');
    // Taken after: the guard lifts.
    expect(
      decide(buildInput([repay(usdt(400))], w, { snapshot: snapAt(4), recentActions: [other] }))
        .outcome,
    ).toBe('act');
  });

  it('a discretionary trade in flight does not hold up an emergency repay', () => {
    const w = makeWorld({ lending: watch });
    const d = decide(
      buildInput([repay(usdt(400))], w, {
        recentActions: [recent('swap-key', 'executed', 5, 'allocation.swap')],
      }),
    );
    expect(d.outcome).toBe('act');
  });
});

describe('decide: purity and determinism', () => {
  it('same input -> identical decision, and the input is not mutated', () => {
    const w = makeWorld({ lending: watch });
    const input = buildInput([repay(usdt(400)), supply(usdt(400)), noAction()], w);
    const before = json({ ...input, quarantined: [...input.quarantined] });
    const a = decide(input);
    const b = decide(input);
    expect(json(a)).toBe(json(b));
    expect(a.decisionId).toBe(b.decisionId);
    expect(json({ ...input, quarantined: [...input.quarantined] })).toBe(before);
  });

  it('proposal order does not matter', () => {
    const w = makeWorld({ lending: watch });
    const ps = [repay(usdt(400)), supply(usdt(400)), noAction(), signal(2)];
    const a = decide(buildInput(ps, w));
    const b = decide(buildInput([...ps].reverse(), w));
    expect(a.decisionId).toBe(b.decisionId);
    expect(json(a.ranked)).toBe(json(b.ranked));
  });

  it('the inputs hash covers everything the decision depends on', () => {
    const w = makeWorld({ lending: watch });
    const base = decide(buildInput([repay(usdt(400))], w));
    const variants = [
      decide(buildInput([repay(usdt(400))], w, { persistedMode: 'risk_reduction_only' })),
      decide(buildInput([repay(usdt(399))], w)),
      decide(buildInput([repay(usdt(400))], w, { now: new Date(NOW.getTime() + 1000) })),
      decide(buildInput([repay(usdt(400))], w, { quarantined: new Set(['capital-allocator']) })),
      decide(
        buildInput([repay(usdt(400))], w, {
          recentActions: [{ actionKey: 'x', kind: 'lending.repay', status: 'dry_run', at: NOW }],
        }),
      ),
      decide(
        buildInput(
          [repay(usdt(400))],
          makeWorld({ lending: { collateralNear: 100, debtUsdt: 231 } }),
        ),
      ),
    ];
    for (const v of variants) expect(v.inputsHash).not.toBe(base.inputsHash);
    expect(new Set([base, ...variants].map((d) => d.inputsHash)).size).toBe(variants.length + 1);
  });
});
