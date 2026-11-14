import {
  accountId,
  type AssetRisk,
  type StrategyId,
  type PortfolioSnapshot,
  type TokenId,
} from '@near-autopilot/core';
import {
  assessRisk,
  LiquidationGuardianAgent,
  parseAgentOutput,
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
  type AnalysisEvent,
  type LlmCallRecord,
  type ToolLlmDeps,
} from '../src/analytics/ai-analysis';
import type { PortfolioRecommendation } from '../src/analytics/account-view';
import { lpObservation, type WalletObservation } from '../src/analytics/lp-recentre';

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
function observation(strategy: StrategyId = 'balanced'): AgentObservation {
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
  const config = walletAgentConfig([WNEAR, USDT], strategy);
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
    { id: '5', name: 'lp_optimizer', input: {} },
  ],
};
const REPAY = 'liquidation-guardian:repay:usdt.tether-token.near';
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
    expect(out.trace).toEqual([]);
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

  it('offers the three orchestrator agents and the three wallet checks as tools', async () => {
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
      'lp_optimizer',
      'burrow_withdrawals',
    ]);
  });

  it('the guardian offers the repay from collateral when the wallet cannot repay, never a dead end', async () => {
    const fromCollateral: PortfolioRecommendation = {
      id: 'improve-loan-safety',
      kind: 'improve_loan_safety',
      agent: 'Liquidation Guardian',
      severity: 'warning',
      title: "Your loan's health factor is 1.37",
      why: 'Repaying 50.00 USDt (about $50) from your USDt collateral on Burrow raises it to 1.60.',
      intent: { action: 'repay_from_collateral', token: USDT, approxUsd: 50, amount: '50000000' },
    };
    const noWalletUsdt = (): AgentObservation => {
      const o = observation();
      return {
        ...o,
        snapshot: {
          ...o.snapshot,
          walletBalances: o.snapshot.walletBalances.filter((b) => b.token !== USDT),
        },
      };
    };
    let guardianOutput: unknown;
    const { llm } = fake([
      () => callAll,
      (results) => {
        guardianOutput = JSON.parse(results?.[0]?.content ?? 'null');
        return final([{ id: 'improve-loan-safety', why: 'Repay from collateral.' }]);
      },
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => noWalletUsdt(),
      heuristics: [fromCollateral],
      checks: [fromCollateral],
      ownerVerified: true,
    });
    expect(guardianOutput).toMatchObject({ candidates: [{ id: 'improve-loan-safety' }] });
    expect(out.source).toBe('llm');
    expect(out.recommendations.map((r) => r.intent?.action)).toEqual(['repay_from_collateral']);
  });

  it('the guardian offers withdraw -> swap -> repay with another collateral, with the HF after each step', async () => {
    const swapRepay: PortfolioRecommendation = {
      id: 'improve-loan-safety',
      kind: 'improve_loan_safety',
      agent: 'Liquidation Guardian',
      severity: 'warning',
      title: "Your loan's health factor is 1.37",
      why: 'This repays it with your wNEAR in three transactions.',
      intent: {
        action: 'repay_with_collateral',
        token: USDT,
        collateralToken: 'wrap.near',
        approxUsd: 56,
        amount: '19000000000000000000000000',
        withdraw: '19000000000000000000000000',
        maxSlippageBps: 50,
        plan: {
          hfNow: 1.37,
          hfAfterWithdraw: 1.24,
          hfAfterRepay: 1.6,
          floorHf: 1.15,
          transactions: 3,
        },
      },
    };
    const o = observation();
    const noWalletUsdt: AgentObservation = {
      ...o,
      snapshot: {
        ...o.snapshot,
        walletBalances: o.snapshot.walletBalances.filter((b) => b.token !== USDT),
      },
    };
    let guardianOutput: unknown;
    const { llm } = fake([
      () => callAll,
      (results) => {
        guardianOutput = JSON.parse(results?.[0]?.content ?? 'null');
        return final([{ id: 'improve-loan-safety', why: 'Swap collateral and repay.' }]);
      },
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => noWalletUsdt,
      heuristics: [swapRepay],
      checks: [swapRepay],
      ownerVerified: true,
    });
    expect(guardianOutput).toMatchObject({ candidates: [{ id: 'improve-loan-safety' }] });
    expect(out.source).toBe('llm');
    expect(out.recommendations.map((r) => r.intent?.action)).toEqual(['repay_with_collateral']);
    expect(JSON.stringify(out.trace)).toContain('1.24 after withdrawing collateral');
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
      'lp_optimizer',
    ]);
    expect(out.recommendations.map((r) => r.id)).toEqual([
      'reduce-concentration',
      'liquidation-guardian:repay:usdt.tether-token.near',
    ]);
    expect(out.run?.checks).toEqual({
      picked: 2,
      explained: 2,
      replaced: 0,
      restored: 0,
      dropped: 1,
    });
    expect(out.recommendations[0]?.why).toBe('wNEAR is 84% of the portfolio.');
    const repay = out.recommendations[1];
    expect(repay?.agent).toBe('Liquidation Guardian');
    expect(repay?.intent).toMatchObject({ action: 'repay', token: USDT });
    const intent = repay?.intent as { amount: string; approxUsd: number };
    expect(BigInt(intent.amount)).toBeGreaterThan(0n);
    expect(BigInt(intent.amount)).toBeLessThanOrEqual(usdt(100));
    expect(intent.approxUsd).toBeCloseTo(Number(intent.amount) / 1e6, 1);
  });

  it('traces each called agent once, in call order, with its key number and provenance', async () => {
    const { llm } = fake([
      () => callAll,
      () => ({ kind: 'tool_calls', calls: [{ id: '6', name: 'liquidation_guardian', input: {} }] }),
      () =>
        final([
          { id: REPAY, why: 'Repay first.' },
          { id: 'capital-allocator:supply:usdt.tether-token.near', why: 'Earn on it.' },
          { id: heuristic.id, why: 'Worth a look.' },
        ]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace).toEqual([
      {
        tool: 'liquidation_guardian',
        agent: 'Liquidation Guardian',
        ok: true,
        text: 'Health factor 1.37 → 1.60 after repaying 33.125 USDt',
        provenance: 'calculated_estimate',
        pick: 'ranked',
        rank: 1,
      },
      {
        tool: 'capital_allocator',
        agent: 'Capital Allocator',
        ok: true,
        text: 'Supply 100 USDt at about 8.0% a year',
        provenance: 'protocol_reported',
        pick: 'ranked',
        rank: 2,
      },
      {
        tool: 'market_intelligence',
        agent: 'Market Intelligence',
        ok: true,
        text: 'Largest gap to a second price source: 0.00% (wNEAR)',
        provenance: 'external_market',
        pick: null,
        rank: null,
      },
      {
        tool: 'portfolio_concentration',
        agent: 'Portfolio Intelligence',
        ok: true,
        text: heuristic.title,
        provenance: 'calculated_estimate',
        pick: 'ranked',
        rank: 3,
      },
      {
        tool: 'lp_optimizer',
        agent: 'Liquidity Optimizer',
        ok: true,
        text: 'No position out of range; nothing to do',
        provenance: null,
        pick: null,
        rank: null,
      },
    ]);
    const card = out.recommendations.find((r) => r.id === REPAY);
    expect(card?.title).toContain('1.37');
  });

  it('traces a failed agent as failed and leaves out tools the model made up', async () => {
    const { llm } = fake([
      () => ({
        kind: 'tool_calls',
        calls: [
          { id: '1', name: 'liquidation_guardian', input: { x: 1 } },
          { id: '2', name: 'sign_everything', input: {} },
          { id: '3', name: 'portfolio_concentration', input: {} },
        ],
      }),
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace).toEqual([
      {
        tool: 'liquidation_guardian',
        agent: 'Liquidation Guardian',
        ok: false,
        text: 'Failed',
        provenance: null,
        pick: null,
        rank: null,
      },
      {
        tool: 'portfolio_concentration',
        agent: 'Portfolio Intelligence',
        ok: true,
        text: heuristic.title,
        provenance: 'calculated_estimate',
        pick: 'ranked',
        rank: 1,
      },
    ]);
  });

  it('never says "no loan" for a loan whose health factor cannot be computed', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const unpriced = async () => {
      const o = observation();
      const prices = new Map(o.snapshot.prices);
      prices.delete(WNEAR);
      const snapshot = { ...o.snapshot, prices };
      return { ...o, snapshot, risk: assessRisk(snapshot, o.config) };
    };
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: unpriced,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace.find((t) => t.tool === 'liquidation_guardian')?.text).toBe(
      'Health factor unknown: a price is missing',
    );
  });

  const healthy = async () => {
    const o = observation();
    const snapshot = { ...o.snapshot, walletBalances: [], lending: null };
    return { ...o, snapshot, risk: assessRisk(snapshot, o.config) };
  };

  it('shows what each agent checked on a wallet with nothing to act on, without a model call', async () => {
    const { llm, tools } = fake([() => callAll, () => final([])]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: healthy,
      heuristics: [],
      checks: [],
    });
    expect(tools).toEqual([]);
    expect(out).toMatchObject({ fallback: 'nothing_to_rank', recommendations: [], run: null });
    expect(out.trace.find((t) => t.tool === 'liquidation_guardian')?.text).toBe(
      'No Burrow loan; nothing to do',
    );
  });

  it('says in code-built words why a safe loan on Aggressive leaves nothing to do', async () => {
    const { llm, tools } = fake([() => callAll, () => final([])]);
    const safeLoan = async () => {
      const o = observation('aggressive');
      const snapshot = { ...o.snapshot, walletBalances: [] };
      return { ...o, snapshot, risk: assessRisk(snapshot, o.config) };
    };
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: safeLoan,
      strategy: 'aggressive',
      heuristics: [],
      checks: [],
      concentration: { token: WNEAR, pct: 60 },
    });
    expect(tools).toEqual([]);
    expect(out.fallback).toBe('nothing_to_rank');
    expect(out.read).toEqual({ tokens: 2, loan: true });
    expect(out.trace.find((t) => t.tool === 'liquidation_guardian')?.text).toBe(
      'Health factor 1.37; safe from 1.25 on Aggressive',
    );
    expect(out.note).toBe(
      [
        'Health factor 1.37; safe from 1.25 on Aggressive',
        'Nothing idle to put to work',
        '60% of your portfolio is in wNEAR; no swap from the wallet suggested',
        'No position out of range; nothing to do',
        'Nothing on Burrow to move to the wallet',
      ].join(' · '),
    );
  });

  it('still falls back when the model drops every real candidate', async () => {
    const { llm } = fake([() => callAll, () => final([])]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.source).toBe('heuristic');
    expect(out.fallback).toBe('empty');
    expect(out.recommendations).toEqual([heuristic]);
  });

  it('records what the model picked when every pick is an id no tool returned', async () => {
    const l = ledger();
    const { llm } = fake([() => callAll, () => final([{ id: 'made-up', why: 'Trust me.' }])]);
    const out = await analyseAccount(ai(llm, l), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.fallback).toBe('empty');
    expect(l.rows[0]?.output).toEqual({
      picks: [{ id: 'made-up', kind: null, why: 'Trust me.' }],
    });
  });

  it('never says "nothing to do" for a loan below target the wallet cannot repay', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const empty = async () => {
      const o = observation();
      const snapshot = { ...o.snapshot, walletBalances: [] };
      return { ...o, snapshot, risk: assessRisk(snapshot, o.config) };
    };
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: empty,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace.find((t) => t.tool === 'liquidation_guardian')?.text).toBe(
      'Health factor 1.37 is below target; no USDt in the wallet to repay with',
    );
  });

  it('marks a loan warning the model left out as kept by code', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace.find((t) => t.tool === 'liquidation_guardian')).toMatchObject({
      pick: 'kept',
      rank: 1,
    });
  });

  it('states the concentration share even when there is no card to move it', async () => {
    const { llm } = fake([() => callAll, () => final([{ id: REPAY, why: 'Repay first.' }])]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [],
      checks: [],
      concentration: { token: USDT, pct: 70.7 },
    });
    expect(out.trace.find((t) => t.tool === 'portfolio_concentration')).toMatchObject({
      text: '71% of your portfolio is in USDt; no swap from the wallet suggested',
      provenance: 'calculated_estimate',
      pick: null,
    });
  });

  it("links an agent's line to the rule-based card of its kind the user sees", async () => {
    const ruleRepay: PortfolioRecommendation = {
      id: 'improve-loan-safety',
      kind: 'improve_loan_safety',
      agent: 'Liquidation Guardian',
      severity: 'warning',
      title: "Your loan's health factor is 1.37",
      why: 'Repay about $69 of your USDt debt.',
      intent: { action: 'repay', token: USDT, approxUsd: 69 },
    };
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const empty = async () => {
      const o = observation();
      const snapshot = { ...o.snapshot, walletBalances: [] };
      return { ...o, snapshot, risk: assessRisk(snapshot, o.config) };
    };
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: empty,
      heuristics: [ruleRepay, heuristic],
      checks: [ruleRepay, heuristic],
    });
    expect(out.recommendations[0]?.id).toBe('improve-loan-safety');
    expect(out.trace.find((t) => t.tool === 'liquidation_guardian')).toMatchObject({
      pick: 'kept',
      rank: 1,
    });
  });

  it('summarises the run: model, turns, tool calls and time', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.run).toEqual({
      model: 'claude-haiku-5-5',
      turns: 2,
      toolCalls: 5,
      ms: expect.any(Number) as number,
      read: { tokens: 2, loan: true },
      checks: { picked: 1, explained: 1, replaced: 0, restored: 1, dropped: 0 },
      ranking: null,
    });
    const off = await analyseAccount(null, {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(off.run).toBeNull();
  });

  it('shows what the model left out, marked as left out', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace.find((t) => t.tool === 'capital_allocator')).toMatchObject({
      text: 'Supply 100 USDt at about 8.0% a year',
      pick: 'left_out',
      rank: null,
    });
  });

  it('says when no second price source was there to compare', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const bare = async () => {
      const o = observation();
      return { ...o, market: { ...o.market!, referencePrices: new Map() } };
    };
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: bare,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace.find((t) => t.tool === 'market_intelligence')).toMatchObject({
      ok: true,
      text: 'No second price source or volatility to compare',
      provenance: null,
    });
  });

  it('counts an explanation replaced for a number no tool returned', async () => {
    const { llm } = fake([
      () => callAll,
      () =>
        final([
          { id: REPAY, why: 'Repay first.' },
          { id: 'reduce-concentration', why: 'Sell $999,999 of wNEAR now.' },
          { id: REPAY, why: 'Again.' },
        ]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.run?.checks).toEqual({
      picked: 2,
      explained: 1,
      replaced: 1,
      restored: 0,
      dropped: 1,
    });
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

  it.each([
    ['full-width digits', 'Repay １００ USDt now.'],
    ['Arabic-Indic digits', 'Repay ٣٠٠ USDt now.'],
    ['a vulgar fraction', 'Repay ½ of the loan.'],
    ['a magnitude word', 'Repay a thousand USDt now.'],
    ['a sign the tools never showed', 'Your loan is -1.37 from safety.'],
    ['a number from another card', 'Repay 8 USDt now.'],
    ['a scale suffix on a shown number', 'Repay now: $1.37k is at risk.'],
    ['a multiplier on a shown number', 'The loan costs 1.37x what it should.'],
    ['a "times" on a shown number', 'The loan is 1.37 times riskier.'],
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

  const BOTH = [
    { id: REPAY, why: 'Repay first.' },
    { id: 'reduce-concentration', why: 'Then spread out.' },
  ];
  const rankingFor = async (ranking?: unknown, picks: unknown = BOTH) => {
    const { llm } = fake([
      () => callAll,
      () => ({ kind: 'final', text: JSON.stringify({ picks, ranking }) }),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.source).toBe('llm');
    return out.run?.ranking;
  };
  const honest = 'The loan comes first: at health factor 1.37, repaying 33.125 USDt reaches 1.60.';

  it('shows the ranking sentence when its numbers come from the shown cards and the tools', async () => {
    expect(await rankingFor(honest)).toBe(honest);
  });

  it.each([
    ['a number no tool returned', 'Repay first: $999,999 is at stake.'],
    ['a number from a card the user does not see', 'Supplying at 8% can wait.'],
    ['a sentence over 300 characters', 'The loan comes first. '.repeat(15)],
    ['an empty sentence', ''],
  ])('drops the ranking sentence with %s and keeps the cards', async (_, ranking) => {
    expect(await rankingFor(ranking)).toBeNull();
  });

  it('drops the ranking sentence when code puts a skipped warning first', async () => {
    expect(
      await rankingFor(honest, [{ id: 'reduce-concentration', why: 'Spread out.' }]),
    ).toBeNull();
  });

  it('drops the ranking sentence when there is only one card to order', async () => {
    expect(await rankingFor(honest, [{ id: REPAY, why: 'Repay first.' }])).toBeNull();
  });

  it('works without a ranking sentence', async () => {
    expect(await rankingFor()).toBeNull();
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

  it("carries the rule card's line on what the strategy weighed onto the AI supply card (#132)", async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'capital-allocator:supply:usdt.tether-token.near', why: 'Earn 8%.' }]),
    ]);
    const weighed = {
      text: 'Aggressive: a loop would earn less.',
      provenance: 'calculated_estimate',
    } as const;
    const idle: PortfolioRecommendation = {
      id: 'put-idle-to-work',
      kind: 'put_idle_to_work',
      agent: 'Capital Allocator',
      severity: 'info',
      title: '$100 of USDt is sitting idle',
      why: 'USDt in your wallet earns nothing.',
      intent: { action: 'supply', token: USDT, approxUsd: 100 },
      carry: weighed,
    };
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [idle],
      checks: [idle],
      ownerVerified: true,
    });
    expect(out.recommendations.find((r) => r.kind === 'put_idle_to_work')?.carry).toEqual(weighed);
  });

  it('supplies the whole idle balance like the rule-based card, past the $100 swap limit', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'capital-allocator:supply:usdt.tether-token.near', why: 'Earn 8%.' }]),
    ]);
    const obs = observation();
    const rich: AgentObservation = {
      ...obs,
      snapshot: { ...obs.snapshot, walletBalances: [{ token: USDT, raw: usdt(507.42) }] },
    };
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => rich,
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    const card = out.recommendations.find((r) => r.kind === 'put_idle_to_work');
    expect(card?.intent).toMatchObject({ amount: usdt(507.42).toString() });
    expect(card?.title).toBe('Put $507.42 of your idle USDt to work');
  });

  it('skips an idle token under 1% a year, like the rule-based card', async () => {
    let tools: unknown;
    const { llm } = fake([
      () => callAll,
      (results) => {
        tools = results;
        return final([{ id: 'capital-allocator:supply:usdt.tether-token.near', why: 'Earn.' }]);
      },
    ]);
    const obs = observation();
    const low: AgentObservation = {
      ...obs,
      snapshot: {
        ...obs.snapshot,
        walletBalances: [...obs.snapshot.walletBalances, { token: WNEAR, raw: near(10_000) }],
      },
      market: {
        ...obs.market!,
        estimatedYieldWad: new Map([
          [USDT, 8n * 10n ** 16n],
          [WNEAR, 5n * 10n ** 15n],
        ]),
      },
    };
    await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => low,
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(JSON.stringify(tools)).not.toContain('capital-allocator:supply:wrap.near');
  });

  it('offers a supply for every idle token, most dollars a year first, with the yearly earnings', async () => {
    let tools: unknown;
    const { llm } = fake([
      () => callAll,
      (results) => {
        tools = results;
        return final([{ id: 'capital-allocator:supply:wrap.near', why: 'Earn on it.' }]);
      },
    ]);
    const obs = observation();
    const both: AgentObservation = {
      ...obs,
      market: {
        ...obs.market!,
        estimatedYieldWad: new Map([
          [USDT, 8n * 10n ** 16n],
          [WNEAR, 2n * 10n ** 16n],
        ]),
      },
    };
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => both,
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    const shown = JSON.stringify(tools);
    expect(shown.indexOf('capital-allocator:supply:usdt.tether-token.near')).toBeGreaterThan(-1);
    expect(shown.indexOf('capital-allocator:supply:usdt.tether-token.near')).toBeLessThan(
      shown.indexOf('capital-allocator:supply:wrap.near'),
    );
    expect(shown).toContain('about $8.00 a year');
    expect(out.recommendations.find((r) => r.kind === 'put_idle_to_work')).toMatchObject({
      intent: { action: 'supply', token: WNEAR },
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

  it('with no action worth $1 calls no model, records no spend and says there is nothing to rank', async () => {
    const dust = observation();
    const snapshot = { ...dust.snapshot, walletBalances: [{ token: USDT, raw: usdt(0.5) }] };
    const l = ledger();
    const { llm, tools } = fake([() => callAll, () => final([])]);
    const out = await analyseAccount(ai(llm, l), {
      accountId: ALICE,
      observe: async () => ({ ...dust, snapshot }),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(tools).toEqual([]);
    expect(l.rows).toEqual([]);
    expect(out).toMatchObject({ source: 'heuristic', fallback: 'nothing_to_rank', run: null });
    expect(out.note).toMatch(
      /^Health factor 1.37 is below target; .* · Nothing on Burrow to move to the wallet$/,
    );
    expect(out.trace.map((t) => t.tool)).toEqual([
      'liquidation_guardian',
      'capital_allocator',
      'market_intelligence',
      'portfolio_concentration',
      'lp_optimizer',
      'burrow_withdrawals',
    ]);
    expect(out.trace.every((t) => t.ok && t.pick === null)).toBe(true);
  });

  it('does not offer a supply under 1% a year, the same floor as the rule-based card', async () => {
    const base = observation();
    const snapshot = {
      ...base.snapshot,
      walletBalances: [{ token: WNEAR, raw: near(1) }],
      lending: null,
    };
    const l = ledger();
    const { llm, tools } = fake([() => callAll, () => final([])]);
    const out = await analyseAccount(ai(llm, l), {
      accountId: ALICE,
      observe: async () => ({
        ...base,
        snapshot,
        risk: assessRisk(snapshot, base.config),
        market: { ...base.market!, estimatedYieldWad: new Map([[WNEAR, 3n * 10n ** 15n]]) },
      }),
      heuristics: [],
      checks: [],
      ownerVerified: true,
    });
    expect(tools).toEqual([]);
    expect(l.rows).toEqual([]);
    expect(out.fallback).toBe('nothing_to_rank');
    expect(out.trace.find((s) => s.tool === 'capital_allocator')?.text).toBe(
      'wNEAR earns about 0.30% a year on Burrow, under the 1% worth suggesting',
    );
  });

  it('still asks the model when the page shows a card the agents did not offer', async () => {
    const dust = observation();
    const snapshot = { ...dust.snapshot, walletBalances: [{ token: USDT, raw: usdt(0.5) }] };
    const warning: PortfolioRecommendation = { ...heuristic, severity: 'warning', intent: null };
    const { llm, tools } = fake([() => callAll, () => final([])]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => ({ ...dust, snapshot }),
      heuristics: [warning],
      checks: [warning],
      ownerVerified: true,
    });
    expect(tools).toHaveLength(1);
    expect(out.fallback).not.toBe('nothing_to_rank');
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

  it("the guardian's wallet repay shows the loan's carry line, also with no rule-based loan card", async () => {
    const carry = {
      text: 'Loan costs 6.5% a year (≈ $0.21/month); your Burrow deposits earn ≈ $0.19/month.',
      provenance: 'calculated_estimate' as const,
    };
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'liquidation-guardian:repay:usdt.tether-token.near', why: 'Repay.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      accountId: ALICE,
      observe: async () => observation(),
      heuristics: [],
      checks: [],
      loanCarry: carry,
      ownerVerified: true,
    });
    expect(out.recommendations[0]?.intent?.action).toBe('repay');
    expect(out.recommendations[0]?.carry).toEqual(carry);
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
      expect(first.cachedAt).toBeNull();
      expect(second).toEqual({ ...first, cachedAt: expect.any(String) as unknown });
      expect(Date.parse(second.cachedAt!)).toBeLessThanOrEqual(Date.now());
      expect(again.tools).toEqual([]);
      expect(l.rows).toHaveLength(1);
    });

    it('a second request while the same run is in flight waits for it: one model run, one row', async () => {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const model = fake([async () => (await gate, callAll), () => final(pick)]);
      const l = ledger();
      const deps = ai(model.llm, l);
      const input = { ...ctx, heuristics: [heuristic], checks: [heuristic] };
      const first = analyseAccount(deps, input);
      await vi.waitFor(() => expect(model.tools).toHaveLength(1));
      const second = analyseAccount(deps, { ...input, observe: async () => later() });
      open();
      const [a, b] = await Promise.all([first, second]);
      expect(a.source).toBe('llm');
      expect(b).toEqual(a);
      expect(model.tools).toHaveLength(1);
      expect(l.rows).toHaveLength(1);
      expect(deps.memo.runs).toHaveLength(1);
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
        'lp_optimizer',
        'market_intelligence',
        'portfolio_concentration',
      ]);
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
      expect(Object.keys(row).sort()).toEqual(
        [
          'accountId',
          'at',
          'costMicroUsd',
          'inputTokens',
          'latencyMs',
          'model',
          'outcome',
          'outputTokens',
          'tools',
          'input',
          'output',
        ].sort(),
      );
      expect(row.input).toMatchObject({ strategy: 'balanced' });
      expect(row.input?.candidates).toContainEqual({
        id: 'reduce-concentration',
        kind: 'reduce_concentration',
      });
      expect(row.output).toEqual({
        picks: [{ id: 'reduce-concentration', kind: 'reduce_concentration', why: 'Diversify.' }],
      });
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
      expect(l.rows).toMatchObject([{ outcome: 'invalid_output', output: { reply: turn.text } }]);
    });

    it('caps the stored reply of an invalid output at 2000 characters', async () => {
      const l = ledger();
      await analyseAccount(ai(fake([() => ({ kind: 'final', text: 'x'.repeat(5000) })]).llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(l.rows[0]?.output).toEqual({ reply: 'x'.repeat(2000) });
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

    it('stops a run when the caller aborts, cancels the call in flight and records it as cancelled', async () => {
      const l = ledger();
      const stop = new AbortController();
      let inFlight: AbortSignal | undefined;
      let turn = 0;
      const llm: ToolLlm = {
        open: (req) => {
          inFlight = req.signal;
          return {
            send: () => {
              req.onUsage?.({ inputTokens: 1000, outputTokens: 100 });
              if (turn++ > 0) {
                setTimeout(() => stop.abort(), 0);
                return new Promise<LlmToolTurn>(() => {});
              }
              return Promise.resolve(callAll);
            },
          };
        },
      };
      const out = await analyseAccount(
        { ...ai(llm, l), memo: analysisMemo(undefined, 0) },
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        () => {},
        undefined,
        undefined,
        stop.signal,
      );
      expect(out.fallback).toBe('cancelled');
      expect(inFlight?.aborted).toBe(true);
      expect(l.rows).toMatchObject([{ outcome: 'cancelled' }]);
    });

    it('keeps a run going when its caller leaves and a retry joins within the grace', async () => {
      const first = new AbortController();
      let answer!: (turn: LlmToolTurn) => void;
      let inFlight: AbortSignal | undefined;
      const llm: ToolLlm = {
        open: (req) => {
          inFlight = req.signal;
          return { send: () => new Promise<LlmToolTurn>((resolve) => (answer = resolve)) };
        },
      };
      const deps = { ...ai(llm), memo: analysisMemo(undefined, 50) };
      const input = { ...ctx, heuristics: [heuristic], checks: [heuristic] };
      const one = analyseAccount(deps, input, () => {}, undefined, undefined, first.signal);
      await vi.waitFor(() => expect(inFlight).toBeDefined());
      first.abort();
      const two = analyseAccount(
        deps,
        input,
        () => {},
        undefined,
        undefined,
        new AbortController().signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(inFlight?.aborted).toBe(false);
      answer(final([]));
      expect((await two).fallback).toBe((await one).fallback);
      expect((await two).fallback).not.toBe('cancelled');
    });

    it('calls no model for a run aborted before it starts', async () => {
      const l = ledger();
      const model = fake([() => final([])]);
      const out = await analyseAccount(
        { ...ai(model.llm, l), memo: analysisMemo(undefined, 0) },
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        () => {},
        undefined,
        undefined,
        AbortSignal.abort(),
      );
      expect(out.fallback).toBe('cancelled');
      expect(model.tools).toEqual([]);
      expect(l.rows).toEqual([]);
    });

    it('counts a call cut off by the deadline at its worst case, so the next run sees the budget reached', async () => {
      const l = ledger(150n + 2n * WORST_CALL_MICRO - 1n);
      let turn = 0;
      const hung: ToolLlm = {
        open: (req) => ({
          send: () => {
            if (turn++ > 0) return new Promise<LlmToolTurn>(() => {});
            req.onUsage?.({ inputTokens: 1000, outputTokens: 100 });
            return Promise.resolve(callAll);
          },
        }),
      };
      const out = await analyseAccount(
        ai(hung, l),
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        () => {},
        50,
      );
      expect(out.fallback).toBe('deadline');
      expect(l.rows).toMatchObject([
        { outcome: 'deadline', costMicroUsd: 150n + WORST_CALL_MICRO },
      ]);

      const next = fake([() => final([])]);
      const again = await analyseAccount(ai(next.llm, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(again.fallback).toBe('cap');
      expect(next.tools).toEqual([]);
    });

    it('counts a call that failed without reporting usage (a dropped connection) at its worst case', async () => {
      const dropped: ToolLlm = {
        open: () => ({
          send: async () => {
            throw new Error('ECONNRESET');
          },
        }),
      };
      const l = ledger();
      const out = await analyseAccount(ai(dropped, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(out.fallback).toBe('model_error');
      expect(l.rows).toMatchObject([{ outcome: 'model_error', costMicroUsd: WORST_CALL_MICRO }]);
    });

    it('does not count a call twice when its reply came back before the deadline', async () => {
      const l = ledger();
      const out = await analyseAccount(
        ai(fake([() => callAll, () => new Promise<LlmToolTurn>(() => {})]).llm, l),
        { ...ctx, heuristics: [heuristic], checks: [heuristic] },
        () => {},
        50,
      );
      expect(out.fallback).toBe('deadline');
      expect(l.rows).toMatchObject([{ costMicroUsd: 300n }]);
    });

    it('never sends a request that could go over 100K input tokens (the long-context rate)', async () => {
      let sends = 0;
      const big: ToolLlm = {
        open: (req) => ({
          send: async () => {
            sends++;
            req.onUsage?.({ inputTokens: 99_000, outputTokens: 500 });
            return callAll;
          },
        }),
      };
      const l = ledger();
      const out = await analyseAccount(ai(big, l), {
        ...ctx,
        heuristics: [heuristic],
        checks: [heuristic],
      });
      expect(sends).toBe(1);
      expect(out.fallback).toBe('loop_limit');
      expect(l.rows).toMatchObject([{ outcome: 'loop_limit', inputTokens: 99_000 }]);
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

describe('walletAgentConfig per strategy', () => {
  const repayRaw = async (strategy: StrategyId) => {
    const agent = new LiquidationGuardianAgent();
    const out = parseAgentOutput(agent.id, await agent.propose(observation(strategy)));
    const repay = out.proposals.map((p) => p.proposal).find((p) => p.kind === 'lending.repay');
    return repay?.kind === 'lending.repay' ? BigInt(repay.amount) : null;
  };

  it('moves the guardian watch line and repay target with the strategy', () => {
    expect(walletAgentConfig([], 'balanced').risk).toMatchObject({
      watchBelowBps: 15_000,
      targetHealthFactorBps: 16_000,
    });
    expect(walletAgentConfig([], 'conservative').risk).toMatchObject({
      watchBelowBps: 18_000,
      targetHealthFactorBps: 20_000,
    });
    expect(walletAgentConfig([], 'aggressive').risk).toMatchObject({
      watchBelowBps: 12_500,
      targetHealthFactorBps: 13_500,
    });
  });

  it('the same HF 1.37 loan: a larger repay under Conservative, none under Aggressive', async () => {
    const [conservative, balanced, aggressive] = await Promise.all(
      (['conservative', 'balanced', 'aggressive'] as const).map(repayRaw),
    );
    expect(balanced).not.toBeNull();
    expect(conservative! > balanced!).toBe(true);
    expect(aggressive).toBeNull();
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

describe('progress events', () => {
  const live = async (
    llm: ToolLlm,
    deps: ToolLlmDeps = ai(llm),
    extra: Partial<Parameters<typeof analyseAccount>[1]> = {},
  ) => {
    const events: AnalysisEvent[] = [];
    const out = await analyseAccount(
      deps,
      { ...ctx, heuristics: [heuristic], checks: [heuristic], ...extra },
      () => {},
      undefined,
      (e) => events.push(e),
    );
    return { out, events };
  };

  it('reports the read, each agent as its result comes back, the ranking and the checks', async () => {
    const { llm } = fake([
      () => callAll,
      () =>
        final([
          { id: REPAY, why: 'Repay first.' },
          { id: heuristic.id, why: 'Worth a look.' },
        ]),
    ]);
    const { out, events } = await live(llm);
    expect(events.map((e) => e.type)).toEqual([
      'read',
      'asked',
      ...Array<string>(5).fill('agent'),
      'ranked',
      'checked',
    ]);
    expect(events[0]).toEqual({ type: 'read', model: 'claude-haiku-5-5', ...out.run?.read });
    expect(events[1]).toEqual({
      type: 'asked',
      agents: [
        { tool: 'liquidation_guardian', agent: 'Liquidation Guardian' },
        { tool: 'capital_allocator', agent: 'Capital Allocator' },
        { tool: 'market_intelligence', agent: 'Market Intelligence' },
        { tool: 'portfolio_concentration', agent: 'Portfolio Intelligence' },
        { tool: 'lp_optimizer', agent: 'Liquidity Optimizer' },
      ],
    });
    const agents = events.flatMap((e) => (e.type === 'agent' ? [e.step] : []));
    expect(agents).toEqual(
      expect.arrayContaining(out.trace.map((t) => ({ ...t, pick: null, rank: null }))),
    );
    expect(events.at(-2)).toEqual({ type: 'ranked', turns: 2 });
    expect(events.at(-1)).toEqual({ type: 'checked', checks: out.run?.checks });
  });

  it('reports a failed agent once and never a tool the model made up', async () => {
    const { llm } = fake([
      () => ({
        kind: 'tool_calls',
        calls: [
          { id: '1', name: 'liquidation_guardian', input: { x: 1 } },
          { id: '2', name: 'sign_everything', input: {} },
          { id: '3', name: 'portfolio_concentration', input: {} },
          { id: '4', name: 'portfolio_concentration', input: {} },
        ],
      }),
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const { events } = await live(llm);
    expect(events.find((e) => e.type === 'asked')).toEqual({
      type: 'asked',
      agents: [
        { tool: 'liquidation_guardian', agent: 'Liquidation Guardian' },
        { tool: 'portfolio_concentration', agent: 'Portfolio Intelligence' },
      ],
    });
    const agents = events.flatMap((e) => (e.type === 'agent' ? [e.step] : []));
    expect(agents.map((s) => [s.tool, s.ok, s.text])).toEqual([
      ['liquidation_guardian', false, 'Failed'],
      ['portfolio_concentration', true, heuristic.title],
    ]);
  });

  it('reports an agent again when a retry succeeds after a failure', async () => {
    const guardian = (input: object) => ({
      kind: 'tool_calls' as const,
      calls: [{ id: '1', name: 'liquidation_guardian', input }],
    });
    const { llm } = fake([
      () => guardian({ x: 1 }),
      () => guardian({}),
      () => guardian({}),
      () => final([{ id: REPAY, why: 'Repay first.' }]),
    ]);
    const { events } = await live(llm);
    const agents = events.flatMap((e) => (e.type === 'agent' ? [e.step.ok] : []));
    expect(agents).toEqual([false, true]);
  });

  it('ends without checks when the run falls back', async () => {
    const { llm } = fake([() => callAll, () => final([{ id: 'made-up', why: 'x' }])]);
    const { out, events } = await live(llm);
    expect(out.fallback).toBe('empty');
    expect(events.at(-1)).toEqual({ type: 'ranked', turns: 2 });
  });

  it('reports nothing for a cached result or a run that never reaches the model', async () => {
    const deps = ai(fake([() => callAll, () => final([{ id: REPAY, why: 'Repay.' }])]).llm);
    await live(deps.llm, deps);
    expect((await live(deps.llm, deps)).events).toEqual([]);
    expect((await live(deps.llm, deps, { ownerVerified: false })).events).toEqual([]);
  });
});

describe('lp_optimizer tool', () => {
  const USDC = accountId('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  const POOL_ID = `${USDC}|${WNEAR}|100`;
  const CUR = 405_300;
  const position = {
    lpt_id: `${POOL_ID}#7`,
    pool_id: POOL_ID,
    left_point: 399_000,
    right_point: 404_000,
    amount: 100_000_000_000_000n,
  };
  const exit: PortfolioRecommendation = {
    id: `reposition-dcl-${position.lpt_id}`,
    kind: 'reposition_dcl_position',
    agent: 'Liquidity Optimizer',
    severity: 'info',
    title: 'Your USDC/wNEAR liquidity is out of range: exit it to your wallet',
    why: 'This concentrated-liquidity position has drifted outside its price range.',
    intent: { action: 'reposition_dcl', lptId: position.lpt_id, poolId: POOL_ID },
  };
  const walletObservation = (volumeUsd: number | null): WalletObservation => {
    const lp = lpObservation({
      positions: [position],
      pools: new Map([
        [
          POOL_ID,
          {
            pool_id: POOL_ID,
            token_x: USDC,
            token_y: WNEAR,
            fee: 100,
            point_delta: 1,
            current_point: CUR,
            state: 'Running',
            liquidity: 50_000_000_000_000_000n,
          },
        ],
      ]),
      depths: new Map([
        [
          POOL_ID,
          {
            liquidities: {
              a: { left_point: 395_000, right_point: 410_000, amount_l: 50_000_000_000_000_000n },
            },
            orders: {},
          },
        ],
      ]),
      allowedPools: new Set([POOL_ID]),
      volumesUsd: volumeUsd === null ? null : new Map([[POOL_ID, volumeUsd]]),
      priceUsd: (t) => ({ [USDC]: 1, [WNEAR]: 2.5 })[t],
      decimals: (t) => ({ [USDC]: 6, [WNEAR]: 24 })[t],
      label: (t) => (t === WNEAR ? 'wNEAR' : 'USDC'),
    });
    const base = observation();
    return { ...base, market: { ...base.market!, lpPositions: lp.views }, lp: lp.meta };
  };
  let offered: PortfolioRecommendation[] = [];
  const pickAll = (results: readonly ToolResult[] | null) => {
    const lp = results?.find((r) => r.id === '5');
    offered = (JSON.parse(lp?.content ?? '{}') as { candidates: PortfolioRecommendation[] })
      .candidates;
    return final(offered.map((c) => ({ id: c.id, why: 'Worth a look.' })));
  };
  const lpCards = async (volumeUsd: number | null) =>
    (await run(volumeUsd)).recommendations.filter((r) => r.kind === 'reposition_dcl_position');
  const run = (volumeUsd: number | null) =>
    analyseAccount(ai(fake([() => callAll, pickAll]).llm), {
      ...ctx,
      observe: async () => walletObservation(volumeUsd),
      heuristics: [exit],
      checks: [exit],
    });

  it('turns a re-centre that pays back into a card with the new range and payback', async () => {
    const cards = await lpCards(1_000_000);
    expect(cards).toHaveLength(1);
    const card = offered.find((r) => r.id.startsWith('lp-optimizer:recentre:'));
    expect(cards[0]?.id).toBe(card?.id);
    expect(card?.intent).toMatchObject({
      action: 'recentre_dcl',
      lptId: position.lpt_id,
      poolId: POOL_ID,
    });
    const intent = card!.intent as { leftPoint: number; rightPoint: number };
    expect(intent.leftPoint).toBeLessThanOrEqual(CUR);
    expect(intent.rightPoint).toBeGreaterThan(CUR);
    expect(card?.why).toMatch(/pays back in (about \d+ days?|less than a day)/);
    expect(card?.why).toMatch(/wNEAR between [\d.]+ and [\d.]+ USDC/);
  });

  it('keeps only the exit when there is no 24 h volume', async () => {
    expect((await lpCards(null)).map((r) => r.id)).toEqual([exit.id]);
  });

  it('keeps only the exit when nothing trades in the pool', async () => {
    expect((await lpCards(0)).map((r) => r.id)).toEqual([exit.id]);
  });
});

describe('market intelligence volatility on the wallet path', () => {
  it('a 24 h range above 15% is a volatility_spike the trace line names', async () => {
    const base = observation();
    const obs = {
      ...base,
      market: { ...base.market!, volatility24hBps: new Map([[WNEAR, 4000]]) },
    };
    const { llm } = fake([
      () => callAll,
      () => final([{ id: heuristic.id, why: 'Worth a look.' }]),
    ]);
    const out = await analyseAccount(ai(llm), {
      ...ctx,
      observe: async () => obs,
      heuristics: [heuristic],
      checks: [heuristic],
    });
    expect(out.trace.find((t) => t.tool === 'market_intelligence')?.text).toBe(
      'wNEAR: 24h realised volatility 4000 bps',
    );
  });
});
