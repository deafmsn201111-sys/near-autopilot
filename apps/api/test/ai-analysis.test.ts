import {
  accountId,
  type AssetRisk,
  type PortfolioSnapshot,
  type TokenId,
} from '@near-autopilot/core';
import {
  assessRisk,
  type AgentObservation,
  type LlmToolTurn,
  type ToolLlm,
  type ToolResult,
} from '@near-autopilot/orchestrator';
import { describe, expect, it, vi } from 'vitest';
import { analysisKey } from '../src/analytics/analysis-key';
import {
  analyseAccount,
  analysisMemo,
  walletAgentConfig,
  type LlmCallRecord,
  type ToolLlmDeps,
} from '../src/analytics/ai-analysis';
import type { PortfolioRecommendation } from '../src/analytics/account-view';

const ALICE = accountId('alice.near');
const WNEAR = accountId('wrap.near');
const USDT = accountId('usdt.tether-token.near');
const NOW = new Date('2026-11-11T12:00:00Z');
const near = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
const usdt = (n: number) => BigInt(Math.round(n * 1e6));
const risk = (token: TokenId, bps: number): AssetRisk => ({
  token,
  collateralFactorBps: bps,
  borrowFactorBps: bps,
  canBeCollateral: true,
  canBorrow: true,
});

/** HF = 100 NEAR * $5 * 0.7 / (230 USDT / 0.9) ≈ 1.37: in the watch band, so the guardian proposes a repay. */
function observation(): AgentObservation {
  const snapshot: PortfolioSnapshot = {
    accountId: ALICE,
    takenAt: NOW,
    pricesAsOf: NOW,
    nativeBalance: 10n ** 24n,
    walletBalances: [
      { token: WNEAR, raw: near(10) },
      { token: USDT, raw: usdt(100) },
    ],
    lending: {
      protocol: 'burrow',
      accountId: ALICE,
      supplied: [],
      collateral: [{ token: WNEAR, raw: near(100) }],
      borrowed: [{ token: USDT, raw: usdt(230) }],
    },
    prices: new Map([
      [WNEAR, { multiplier: 50_000n, decimals: 28 }],
      [USDT, { multiplier: 10_000n, decimals: 10 }],
    ]),
    risk: new Map([
      [WNEAR, risk(WNEAR, 7000)],
      [USDT, risk(USDT, 9000)],
    ]),
    tokens: new Map([
      [WNEAR, { id: WNEAR, symbol: 'wNEAR', decimals: 24 }],
      [USDT, { id: USDT, symbol: 'USDt', decimals: 6 }],
    ]),
  };
  const config = walletAgentConfig([WNEAR, USDT]);
  return {
    now: NOW,
    accountId: ALICE,
    snapshot,
    market: {
      asOf: NOW,
      estimatedYieldWad: new Map([[USDT, 8n * 10n ** 16n]]),
      referencePrices: new Map(snapshot.prices),
      volatility24hBps: new Map(),
      lpPositions: [],
    },
    risk: assessRisk(snapshot, config),
    config,
  };
}

const heuristic: PortfolioRecommendation = {
  id: 'reduce-concentration',
  kind: 'reduce_concentration',
  agent: 'Portfolio Intelligence',
  severity: 'info',
  title: '84% of your portfolio is in wNEAR',
  why: 'A 84% position in wNEAR means a fall in wNEAR hits almost your whole portfolio.',
  intent: { action: 'swap', fromToken: WNEAR, approxUsd: 170 },
};

/** A fake model: each turn is computed from the tool results it was just sent. */
function fake(
  script: ((results: readonly ToolResult[] | null) => LlmToolTurn | Promise<LlmToolTurn>)[],
) {
  const tools: string[][] = [];
  const llm: ToolLlm = {
    open(req) {
      tools.push(req.tools.map((t) => t.name));
      let i = 0;
      return {
        send: async (results) => {
          const step = script[i++];
          if (!step) throw new Error('script exhausted');
          req.onUsage?.({ inputTokens: 1000, outputTokens: 100 });
          return step(results);
        },
      };
    },
  };
  return { llm, tools };
}

/** Today's spend so far is the rows recorded; `left` is what the cap allows on top of them. */
function ledger(left = 10n ** 9n) {
  const rows: LlmCallRecord[] = [];
  return {
    rows,
    on: true,
    async enabled() {
      return this.on;
    },
    remainingTodayMicro: async () => left - rows.reduce((sum, r) => sum + r.costMicroUsd, 0n),
    record: async (row: LlmCallRecord) => {
      rows.push(row);
    },
  };
}
const ai = (llm: ToolLlm, l: ToolLlmDeps['ledger'] = ledger()): ToolLlmDeps => ({
  llm,
  model: 'claude-haiku-5-5',
  maxTokens: 4096,
  ledger: l,
  memo: analysisMemo(),
});
/** Haiku 5.5, 100K input + 4096 output: the most one call may cost. */
const WORST_CALL_MICRO = 12_048n;
const ctx = { accountId: ALICE, observe: async () => observation(), ownerVerified: true };

const callAll: LlmToolTurn = {
  kind: 'tool_calls',
  calls: [
    { id: '1', name: 'liquidation_guardian', input: {} },
    { id: '2', name: 'capital_allocator', input: {} },
    { id: '3', name: 'market_intelligence', input: {} },
    { id: '4', name: 'portfolio_concentration', input: {} },
    { id: '5', name: 'liquidity_positions', input: {} },
  ],
};
const final = (picks: unknown): LlmToolTurn => ({ kind: 'final', text: JSON.stringify({ picks }) });

describe('analyseAccount', () => {
  it('without a model returns the heuristic list, labelled', async () => {
    const out = await analyseAccount(null, {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(out.source).toBe('heuristic');
    expect(out.recommendations).toEqual([heuristic]);
    expect(out.calledTools).toEqual([]);
  });

  it('does not call the model for a visitor who has not proved ownership', async () => {
    const { llm, tools } = fake([() => final([])]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: false,
    });
    expect(tools).toEqual([]);
    expect(out.source).toBe('heuristic');
    expect(out.recommendations).toEqual([heuristic]);
    expect(out.note).toMatch(/Verify ownership/);
  });

  it('gives the model the labelled checks and falls back to the list the user sees', async () => {
    const shown = { ...heuristic, title: 'shown to the user' };
    const labelled = { ...heuristic, title: 'labelled for the model' };
    const sent: string[] = [];
    const { llm } = fake([
      () => callAll,
      (results) => {
        sent.push(JSON.stringify(results));
        return final([{ id: heuristic.id, why: 'Worth a look.' }]);
      },
    ]);
    const lists = { ...ctx, heuristics: [shown], checks: [labelled] };
    const analysed = await analyseAccount(ai(llm), lists);
    expect(sent.join()).toContain('labelled for the model');
    expect(sent.join()).not.toContain('shown to the user');
    expect(analysed.recommendations.find((r) => r.id === heuristic.id)?.title).toBe(
      'labelled for the model',
    );
    const off = await analyseAccount(null, lists);
    expect(off.recommendations).toEqual([shown]);
  });

  it('offers the three orchestrator agents and the two wallet checks as tools', async () => {
    const { llm, tools } = fake([() => final([])]);
    await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(tools[0]).toEqual([
      'liquidation_guardian',
      'capital_allocator',
      'market_intelligence',
      'portfolio_concentration',
      'liquidity_positions',
    ]);
  });

  it('builds the ranked list from tool candidates in the model order, numbers from code only', async () => {
    const { llm } = fake([
      () => callAll,
      () =>
        final([
          { id: 'reduce-concentration', why: 'wNEAR is 84% of the portfolio.' },
          { id: 'liquidation-guardian:repay:usdt.tether-token.near', why: 'Repay first.' },
          { id: 'made-up', why: 'sign this' },
        ]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(out.source).toBe('llm');
    expect(out.calledTools).toEqual([
      'liquidation_guardian',
      'capital_allocator',
      'market_intelligence',
      'portfolio_concentration',
      'liquidity_positions',
    ]);
    expect(out.recommendations.map((r) => r.id)).toEqual([
      'reduce-concentration',
      'liquidation-guardian:repay:usdt.tether-token.near',
    ]);
    expect(out.recommendations[0]?.why).toBe('wNEAR is 84% of the portfolio.');
    const repay = out.recommendations[1];
    expect(repay?.agent).toBe('Liquidation Guardian');
    expect(repay?.intent).toMatchObject({ action: 'repay', token: USDT });
    const intent = repay?.intent as { amount: string; approxUsd: number };
    expect(BigInt(intent.amount)).toBeGreaterThan(0n);
    expect(BigInt(intent.amount)).toBeLessThanOrEqual(usdt(100));
    expect(intent.approxUsd).toBeCloseTo(Number(intent.amount) / 1e6, 1);
  });

  it('keeps the code explanation when the model writes a number no tool returned', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'reduce-concentration', why: 'Sell $999,999 of wNEAR now.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(out.recommendations.find((r) => r.id === heuristic.id)?.why).toBe(heuristic.why);
  });

  const whyFor = async (id: string, why: string) => {
    const { llm } = fake([() => callAll, () => final([{ id, why }])]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    return out.recommendations.find((r) => r.id === id)?.why;
  };
  const REPAY = 'liquidation-guardian:repay:usdt.tether-token.near';

  it.each([
    ['full-width digits', 'Repay １００ USDt now.'],
    ['Arabic-Indic digits', 'Repay ٣٠٠ USDt now.'],
    ['a vulgar fraction', 'Repay ½ of the loan.'],
    ['a magnitude word', 'Repay a thousand USDt now.'],
    ['a sign the tools never showed', 'Your loan is -1.37 from safety.'],
    ['a number from another card', 'Repay 8 USDt now.'],
  ])('keeps the code explanation for %s', async (_, why) => {
    expect(await whyFor(REPAY, why)).not.toBe(why);
  });

  it.each([
    'Repaying 33.125 USDt lifts the health factor from 1.37 to 1.60.',
    'Your health factor is 1.37; repay about $33.13.',
    'Repay now: the 1.0 line is liquidation.',
  ])('keeps a why that quotes only its own card and the shared context: %s', async (why) => {
    expect(await whyFor(REPAY, why)).toBe(why);
  });

  it('turns the allocator idle-supply proposal into a supply recommendation with an exact amount', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'capital-allocator:supply:usdt.tether-token.near', why: 'Earn 8%.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(out.recommendations.find((r) => r.kind === 'put_idle_to_work')).toMatchObject({
      kind: 'put_idle_to_work',
      agent: 'Capital Allocator',
      intent: { action: 'supply', token: USDT },
    });
  });

  it.each([
    ['invalid JSON', (): LlmToolTurn => ({ kind: 'final', text: 'not json' })],
    ['a model error', (): Promise<LlmToolTurn> => Promise.reject(new Error('529'))],
    ['too many turns', () => callAll],
  ])('falls back to the labelled heuristic list on %s', async (_, step) => {
    const { llm } = fake([() => callAll, step, step, step, step]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(out.source).toBe('heuristic');
    expect(out.recommendations).toEqual([heuristic]);
    expect(out.note).toMatch(/AI/);
  });

  it('falls back when the model does not answer before the deadline', async () => {
    const { llm } = fake([() => new Promise<LlmToolTurn>(() => {})]);
    const out = await analyseAccount(
      ai(llm),
      {
        accountId: ALICE,
        observe: async () => observation(),
        heuristics: [heuristic],
        checks: [heuristic],
        ownerVerified: true,
      },
      () => {},
      20,
    );
    expect(out.source).toBe('heuristic');
  });

  it('never leaves out a loan warning the model skipped', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'reduce-concentration', why: 'Diversify.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(out.recommendations.map((r) => r.kind)).toEqual([
      'improve_loan_safety',
      'reduce_concentration',
    ]);
  });

  it('keeps the loan warning when another card is a warning too', async () => {
    const concentrated = { ...heuristic, severity: 'warning' as const };
    const outOfRange: PortfolioRecommendation = {
      id: 'reposition-dcl-7',
      kind: 'reposition_dcl_position',
      agent: 'Liquidity Optimizer',
      severity: 'warning',
      title: 'Your wNEAR/USDt liquidity is out of range',
      why: 'It earns no fees.',
      intent: { action: 'reposition_dcl', lptId: '7', poolId: 'pool' },
    };
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'reduce-concentration', why: 'Diversify.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [concentrated, outOfRange],
      checks: [concentrated, outOfRange],
      ownerVerified: true,
    });
    expect(out.recommendations.map((r) => r.kind).sort()).toEqual([
      'improve_loan_safety',
      'reduce_concentration',
      'reposition_dcl_position',
    ]);
  });

  it('lists a candidate the model picked twice only once', async () => {
    const { llm } = fake([
      () => callAll,
      () =>
        final([
          { id: 'reduce-concentration', why: 'Diversify.' },
          { id: 'reduce-concentration', why: 'Again.' },
        ]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(out.recommendations.filter((r) => r.id === heuristic.id)).toHaveLength(1);
  });

  it('gives up after 6 model turns', async () => {
    let turns = 0;
    const { llm } = fake(Array.from({ length: 20 }, () => () => (turns++, callAll)));
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [heuristic],
      checks: [heuristic],
      ownerVerified: true,
    });
    expect(turns).toBe(6);
    expect(out.source).toBe('heuristic');
  });

  it('aborts the model call in flight on the deadline', async () => {
    let signal: AbortSignal | undefined;
    const llm: ToolLlm = {
      open(req) {
        signal = req.signal;
        return { send: () => new Promise<LlmToolTurn>(() => {}) };
      },
    };
    await analyseAccount(
      ai(llm),
      {
        accountId: ALICE,
        observe: async () => observation(),
        heuristics: [heuristic],
        checks: [heuristic],
        ownerVerified: true,
      },
      () => {},
      20,
    );
    expect(signal?.aborted).toBe(true);
  });

  it('does not offer agent actions worth less than $1', async () => {
    const dust = observation();
    const snapshot = {
      ...dust.snapshot,
      walletBalances: [{ token: USDT, raw: usdt(0.5) }],
    };
    let candidates: unknown[] = [];
    const { llm } = fake([
      () => callAll,
      (results) => {
        candidates = (results ?? []).flatMap(
          (r) => (JSON.parse(r.content) as { candidates?: unknown[] }).candidates ?? [],
        );
        return final([]);
      },
    ]);
    await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => ({ ...dust, snapshot }),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(candidates).toEqual([]);
  });

  it('falls back when the model ranks nothing', async () => {
    const { llm } = fake([() => callAll, () => final([{ id: 'made-up', why: 'x' }])]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(out.source).toBe('heuristic');
  });

  it('states the health factor the repayment actually reaches', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'liquidation-guardian:repay:usdt.tether-token.near', why: 'Repay.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    const repay = out.recommendations[0];
    expect(repay?.title).toBe("Your loan's health factor is 1.37");
    expect(repay?.why).toBe('Repay.');
    const code = (
      await analyseAccount(
        ai(fake([() => callAll, () => final([{ id: repay!.id, why: '$999' }])]).llm),
        {
          accountId: ALICE,
          observe: async () => observation(),
          heuristics: [],
          checks: [],
          ownerVerified: true,
        },
      )
    ).recommendations[0];
    expect(code?.why).toMatch(/raises the health factor from 1\.37 to 1\.\d\d/);
  });

  it('does not let digits of a raw amount vouch for a number in the why', async () => {
    let raw = '';
    const { llm } = fake([
      () => callAll,
      (results) => {
        const guardian = JSON.parse(results?.[0]?.content ?? '{}') as {
          candidates: { intent: { amount: string } }[];
        };
        raw = guardian.candidates[0]?.intent.amount ?? '';
        return final([
          { id: 'liquidation-guardian:repay:usdt.tether-token.near', why: `Repay ${raw} now.` },
        ]);
      },
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(raw).not.toBe('');
    expect(out.recommendations[0]?.why).not.toContain(raw);
  });

  it('counts reading the wallet against the deadline', async () => {
    const { llm } = fake([() => callAll]);
    const out = await analyseAccount(
      ai(llm),
      {
        ...ctx,
        observe: () => new Promise(() => {}),
        heuristics: [heuristic],
        checks: [heuristic],
      },
      () => {},
      20,
    );
    expect(out.source).toBe('heuristic');
  });

  describe('result cache and global limit', () => {
    const pick = [{ id: 'reduce-concentration', why: 'Most of your portfolio is in one token.' }];
    const ranked = () => fake([() => callAll, () => final(pick)]);
    const later = (): AgentObservation => {
      const obs = observation();
      const t = new Date(NOW.getTime() + 60_000);
      return {
        ...obs,
        now: t,
        snapshot: { ...obs.snapshot, takenAt: t, pricesAsOf: t },
        market: obs.market && { ...obs.market, asOf: t },
      };
    };

    it('answers a repeat analysis of an unchanged wallet from the cache, with no model call and no row', async () => {
      const l = ledger();
      const deps = ai(ranked().llm, l);
      const first = await analyseAccount(deps, {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(first.source).toBe('llm');
      const again = fake([() => callAll]);
      const second = await analyseAccount(
        { ...deps, llm: again.llm },
        { ...ctx, observe: async () => later(), heuristics: [heuristic], checks: [heuristic] },
      );
      expect(second).toEqual(first);
      expect(again.tools).toEqual([]);
      expect(l.rows).toHaveLength(1);
    });

    it('runs the model again once the cached result is 10 minutes old', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const deps = ai(ranked().llm);
        await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] });
        vi.setSystemTime(Date.now() + 10 * 60_000);
        const again = ranked();
        await analyseAccount(
          { ...deps, llm: again.llm },
          { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        );
        expect(again.tools).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not cache a fallback', async () => {
      const deps = ai(fake([() => final([])]).llm);
      expect(
        (await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] }))
          .fallback,
      ).toBe('empty');
      const again = ranked();
      const out = await analyseAccount(
        { ...deps, llm: again.llm },
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
      );
      expect(out.source).toBe('llm');
    });

    it('with the kill switch on makes no model call, serves no cached result, and labels it kill_switch', async () => {
      const l = ledger();
      const deps = ai(ranked().llm, l);
      expect(
        (await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] }))
          .source,
      ).toBe('llm');
      l.on = false;
      const again = fake([() => callAll]);
      const off = await analyseAccount(
        { ...deps, llm: again.llm },
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
      );
      expect(again.tools).toEqual([]);
      expect(off).toMatchObject({
        source: 'heuristic',
        fallback: 'kill_switch',
        recommendations: [heuristic],
      });
      l.on = true;
      const back = await analyseAccount(deps, {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(back.source).toBe('llm');
    });

    it('treats an unreadable kill switch as on', async () => {
      const { llm, tools } = fake([() => callAll]);
      const broken = { ...ledger(), enabled: () => Promise.reject(new Error('db down')) };
      const out = await analyseAccount(ai(llm, broken), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(tools).toEqual([]);
      expect(out.fallback).toBe('kill_switch');
    });

    it('never serves a cached result to a visitor who has not proved ownership', async () => {
      const deps = ai(ranked().llm);
      await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] });
      const out = await analyseAccount(deps, {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
        ownerVerified: false,
      });
      expect(out.fallback).toBe('not_owner');
    });

    it('over the global limit answers with the rule-based list labelled busy, and no model call', async () => {
      const l = ledger();
      const deps = { ...ai(fake([() => final([])]).llm, l), memo: analysisMemo(1) };
      await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] });
      const again = fake([() => final([])]);
      const out = await analyseAccount(
        { ...deps, llm: again.llm },
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
      );
      expect(out).toMatchObject({
        source: 'heuristic',
        fallback: 'busy',
        recommendations: [heuristic],
      });
      expect(out.note).toMatch(/busy/);
      expect(again.tools).toEqual([]);
      expect(l.rows).toHaveLength(1);
    });

    it('does not take a slot for a run the deadline ends before the model', async () => {
      const memo = analysisMemo(1);
      const slow = ledger();
      const deps = {
        ...ai(fake([() => final([])]).llm, {
          ...slow,
          remainingTodayMicro: () => new Promise<bigint>((r) => setTimeout(() => r(10n ** 9n), 40)),
        }),
        memo,
      };
      const out = await analyseAccount(
        deps,
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        () => {},
        20,
      );
      expect(out.fallback).toBe('deadline');
      expect(memo.runs).toEqual([]);
    });

    it('counts only runs that reach the model against the global limit', async () => {
      const memo = analysisMemo(2);
      const deps = { ...ai(ranked().llm), memo };
      await analyseAccount(deps, {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
        ownerVerified: false,
      });
      await analyseAccount(
        { ...deps, ledger: ledger(0n) },
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
      );
      await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] });
      await analyseAccount(deps, { ...ctx, heuristics: [heuristic], checks: [heuristic] });
      const bob = accountId('bob.near');
      const other = ranked();
      const out = await analyseAccount(
        { ...deps, llm: other.llm },
        {
          ...ctx,
          accountId: bob,
          observe: async () => ({ ...observation(), accountId: bob }),
          heuristics: [heuristic],
          checks: [heuristic],
        },
      );
      expect(other.tools).toHaveLength(1);
      expect(out.source).toBe('llm');
    });
  });

  describe('spend', () => {
    it('labels each fallback with its code', async () => {
      expect(
        (await analyseAccount(null, { ...ctx, heuristics: [heuristic], checks: [heuristic] }))
          .fallback,
      ).toBe('off');
      const { llm } = fake([() => final([])]);
      expect(
        (
          await analyseAccount(ai(llm), {
            ...ctx,
            heuristics: [heuristic],
            checks: [heuristic],
            ownerVerified: false,
          })
        ).fallback,
      ).toBe('not_owner');
      expect(
        (
          await analyseAccount(ai(fake([() => final([])]).llm), {
            ...ctx,
            heuristics: [heuristic],
            checks: [heuristic],
          })
        ).fallback,
      ).toBe('empty');
    });

    it('makes no model call once the day’s budget is reached', async () => {
      const { llm, tools } = fake([() => final([])]);
      const l = ledger(WORST_CALL_MICRO - 1n);
      const out = await analyseAccount(ai(llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(tools).toEqual([]);
      expect(out.source).toBe('heuristic');
      expect(out.fallback).toBe('cap');
      expect(out.note).toMatch(/daily AI budget reached/);
      expect(l.rows).toEqual([]);
    });

    it('stops before the next call when it would go over the budget', async () => {
      let turns = 0;
      const { llm } = fake([() => (turns++, callAll), () => (turns++, final([]))]);
      const l = ledger(WORST_CALL_MICRO + 100n);
      const out = await analyseAccount(ai(llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(turns).toBe(1);
      expect(out.fallback).toBe('cap');
      expect(l.rows).toMatchObject([{ outcome: 'cap', inputTokens: 1000, outputTokens: 100 }]);
    });

    it('holds a call in flight against the budget of a parallel analysis', async () => {
      let release!: () => void;
      const slow = fake([
        () => new Promise<LlmToolTurn>((resolve) => (release = () => resolve(final([])))),
      ]);
      const second = fake([() => final([])]);
      const l = ledger(WORST_CALL_MICRO + 100n);
      const first = analyseAccount(ai(slow.llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      await new Promise((r) => setTimeout(r, 10));
      const out = await analyseAccount(ai(second.llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('cap');
      expect(second.tools).toEqual([]);
      release();
      expect((await first).fallback).toBe('empty');
    });

    it('never lets two analyses started together both spend the last worst-case call', async () => {
      const a = fake([() => final([])]);
      const b = fake([() => final([])]);
      const l = ledger(WORST_CALL_MICRO + 100n);
      const outs = await Promise.all([
        analyseAccount(ai(a.llm, l), { ...ctx, heuristics: [heuristic], checks: [heuristic] }),
        analyseAccount(ai(b.llm, l), { ...ctx, heuristics: [heuristic], checks: [heuristic] }),
      ]);
      expect(outs.map((o) => o.fallback)).toContain('cap');
      expect(l.rows.length).toBeLessThanOrEqual(1);
    });

    it('counts a run as spent while its row is being written', async () => {
      let written!: () => void;
      const rows: LlmCallRecord[] = [];
      const slowLedger = {
        enabled: async () => true,
        remainingTodayMicro: async () =>
          WORST_CALL_MICRO + 100n - rows.reduce((t, r) => t + r.costMicroUsd, 0n),
        record: (row: LlmCallRecord) =>
          new Promise<void>((resolve) => (written = () => (rows.push(row), resolve()))),
      };
      const first = analyseAccount(ai(fake([() => final([])]).llm, slowLedger), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      await new Promise((r) => setTimeout(r, 10));
      const second = fake([() => final([])]);
      const out = await analyseAccount(ai(second.llm, slowLedger), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('cap');
      expect(second.tools).toEqual([]);
      written();
      await first;
    });

    it('reports an unreadable budget mid-run as cap', async () => {
      let reads = 0;
      const l = ledger();
      const flaky = {
        ...l,
        remainingTodayMicro: async () => {
          if (++reads === 3) throw new Error('db down');
          return l.remainingTodayMicro();
        },
      };
      const out = await analyseAccount(ai(fake([() => callAll, () => final([])]).llm, flaky), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('cap');
      expect(l.rows).toMatchObject([{ outcome: 'cap' }]);
    });

    it('records one row with the tokens and cost of all turns, the tools called and the outcome', async () => {
      const { llm } = fake([
        () => callAll,
        () => final([{ id: 'reduce-concentration', why: 'Diversify.' }]),
      ]);
      const l = ledger();
      const out = await analyseAccount(ai(llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBeNull();
      expect(l.rows).toHaveLength(1);
      const row = l.rows[0]!;
      expect(row).toMatchObject({
        accountId: ALICE,
        model: 'claude-haiku-5-5',
        inputTokens: 2000,
        outputTokens: 200,
        costMicroUsd: 300n,
        outcome: 'ok',
      });
      expect([...row.tools].sort()).toEqual([
        'capital_allocator',
        'liquidation_guardian',
        'liquidity_positions',
        'market_intelligence',
        'portfolio_concentration',
      ]);
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(row).sort()).toEqual([
        'accountId',
        'at',
        'costMicroUsd',
        'inputTokens',
        'latencyMs',
        'model',
        'outcome',
        'outputTokens',
        'tools',
      ]);
    });

    it('keeps the tokens spent so far when the model fails mid-run', async () => {
      const { llm } = fake([
        () => callAll,
        () => {
          throw new Error('529 overloaded');
        },
      ]);
      const l = ledger();
      const out = await analyseAccount(ai(llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('model_error');
      expect(l.rows).toMatchObject([
        { outcome: 'model_error', inputTokens: 2000, outputTokens: 200 },
      ]);
    });

    it.each([
      ['not JSON', { kind: 'final', text: 'I think you should repay.' }],
      ['JSON of the wrong shape', { kind: 'final', text: '{"picks":"all"}' }],
    ] as const)('tells %s (invalid_output) apart from a model error', async (_, turn) => {
      const l = ledger();
      const out = await analyseAccount(ai(fake([() => turn]).llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('invalid_output');
      expect(l.rows).toMatchObject([{ outcome: 'invalid_output' }]);
    });

    it('records a deadline with its code', async () => {
      const l = ledger();
      const out = await analyseAccount(
        ai(fake([() => callAll, () => new Promise<LlmToolTurn>(() => {})]).llm, l),
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        () => {},
        50,
      );
      expect(out.fallback).toBe('deadline');
      expect(l.rows).toMatchObject([{ outcome: 'deadline', inputTokens: 2000 }]);
    });

    it('records too many turns as loop_limit', async () => {
      const l = ledger();
      const out = await analyseAccount(
        ai(fake(Array.from({ length: 20 }, () => () => callAll)).llm, l),
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
      );
      expect(out.fallback).toBe('loop_limit');
      expect(l.rows).toMatchObject([{ outcome: 'loop_limit', inputTokens: 6000 }]);
    });

    it('makes no model call and still answers when the budget cannot be read', async () => {
      const { llm, tools } = fake([() => final([])]);
      const l = {
        ...ledger(),
        remainingTodayMicro: async (): Promise<bigint> => {
          throw new Error('db down');
        },
      };
      const out = await analyseAccount(ai(llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(tools).toEqual([]);
      expect(out.fallback).toBe('cap');
    });

    it('still answers when the row cannot be written', async () => {
      const l = {
        ...ledger(),
        record: async () => {
          throw new Error('db down');
        },
      };
      const errors: unknown[] = [];
      const out = await analyseAccount(
        ai(
          fake([() => callAll, () => final([{ id: 'reduce-concentration', why: 'Diversify.' }])])
            .llm,
          l,
        ),
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        (e) => errors.push(e),
      );
      expect(out.source).toBe('llm');
      expect(errors).toHaveLength(1);
    });

    // Runs last: the unrecorded spend of the test above stays held in this process.
    it('keeps counting the spend of a run whose row could not be written', async () => {
      const { llm, tools } = fake([() => final([])]);
      const out = await analyseAccount(ai(llm, ledger(WORST_CALL_MICRO + 200n)), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('cap');
      expect(tools).toEqual([]);
    });
  });
});

describe('analysisKey', () => {
  const key = (obs: AgentObservation, preset = 'default') => analysisKey(obs, [heuristic], preset);
  const base = key(observation());

  it('ignores the snapshot and price fetch times', () => {
    const obs = observation();
    const t = new Date(NOW.getTime() + 3_600_000);
    expect(
      key({
        ...obs,
        now: t,
        snapshot: { ...obs.snapshot, takenAt: t, pricesAsOf: t },
        market: obs.market && { ...obs.market, asOf: t },
      }),
    ).toBe(base);
  });

  it('changes with a balance, a debt, a price, the rule-based list or the preset', () => {
    const obs = observation();
    const lending = obs.snapshot.lending!;
    const variants = [
      { ...obs, snapshot: { ...obs.snapshot, walletBalances: [{ token: WNEAR, raw: near(11) }] } },
      {
        ...obs,
        snapshot: {
          ...obs.snapshot,
          lending: { ...lending, borrowed: [{ token: USDT, raw: usdt(231) }] },
        },
      },
      {
        ...obs,
        snapshot: {
          ...obs.snapshot,
          prices: new Map([...obs.snapshot.prices, [WNEAR, { multiplier: 50_100n, decimals: 28 }]]),
        },
      },
    ].map((o) => key(o));
    variants.push(analysisKey(obs, [], 'default'), key(obs, 'conservative'));
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('ignores interest accrued past the leading digits of a debt', () => {
    const obs = observation();
    const lending = obs.snapshot.lending!;
    const accrued = { ...lending, borrowed: [{ token: USDT, raw: usdt(230) + 37n }] };
    expect(key({ ...obs, snapshot: { ...obs.snapshot, lending: accrued } })).toBe(base);
  });

  it('does not depend on map insertion order', () => {
    const obs = observation();
    const prices = new Map([...obs.snapshot.prices].reverse());
    expect(key({ ...obs, snapshot: { ...obs.snapshot, prices } })).toBe(base);
  });
});
