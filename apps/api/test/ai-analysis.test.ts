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
import { describe, expect, it } from 'vitest';
import { analyseAccount, walletAgentConfig } from '../src/analytics/ai-analysis';
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
          return step(results);
        },
      };
    },
  };
  return { llm, tools };
}

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
      observe: async () => observation(),
      heuristics: [heuristic],
      ownerVerified: true,
    });
    expect(out.source).toBe('heuristic');
    expect(out.recommendations).toEqual([heuristic]);
    expect(out.calledTools).toEqual([]);
  });

  it('does not call the model for a visitor who has not proved ownership', async () => {
    const { llm, tools } = fake([() => final([])]);
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [heuristic],
      ownerVerified: false,
    });
    expect(tools).toEqual([]);
    expect(out.source).toBe('heuristic');
    expect(out.recommendations).toEqual([heuristic]);
    expect(out.note).toMatch(/Verify ownership/);
  });

  it('offers the three orchestrator agents and the two wallet checks as tools', async () => {
    const { llm, tools } = fake([() => final([])]);
    await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [heuristic],
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
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [heuristic],
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
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [heuristic],
      ownerVerified: true,
    });
    expect(out.recommendations.find((r) => r.id === heuristic.id)?.why).toBe(heuristic.why);
  });

  it('turns the allocator idle-supply proposal into a supply recommendation with an exact amount', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'capital-allocator:supply:usdt.tether-token.near', why: 'Earn 8%.' }]),
    ]);
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [],
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
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [heuristic],
      ownerVerified: true,
    });
    expect(out.source).toBe('heuristic');
    expect(out.recommendations).toEqual([heuristic]);
    expect(out.note).toMatch(/AI/);
  });

  it('falls back when the model does not answer before the deadline', async () => {
    const { llm } = fake([() => new Promise<LlmToolTurn>(() => {})]);
    const out = await analyseAccount(
      llm,
      { observe: async () => observation(), heuristics: [heuristic], ownerVerified: true },
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
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [heuristic],
      ownerVerified: true,
    });
    expect(out.recommendations.map((r) => r.kind)).toEqual([
      'improve_loan_safety',
      'reduce_concentration',
    ]);
  });

  it('falls back when the model ranks nothing', async () => {
    const { llm } = fake([() => callAll, () => final([{ id: 'made-up', why: 'x' }])]);
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [],
      ownerVerified: true,
    });
    expect(out.source).toBe('heuristic');
  });

  it('states the health factor the repayment actually reaches', async () => {
    const { llm } = fake([
      () => callAll,
      () => final([{ id: 'liquidation-guardian:repay:usdt.tether-token.near', why: 'Repay.' }]),
    ]);
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [],
      ownerVerified: true,
    });
    const repay = out.recommendations[0];
    expect(repay?.title).toBe("Your loan's health factor is 1.37");
    expect(repay?.why).toBe('Repay.');
    const code = (
      await analyseAccount(
        fake([() => callAll, () => final([{ id: repay!.id, why: '$999' }])]).llm,
        { observe: async () => observation(), heuristics: [], ownerVerified: true },
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
    const out = await analyseAccount(llm, {
      observe: async () => observation(),
      heuristics: [],
      ownerVerified: true,
    });
    expect(raw).not.toBe('');
    expect(out.recommendations[0]?.why).not.toContain(raw);
  });

  it('counts reading the wallet against the deadline', async () => {
    const { llm } = fake([() => callAll]);
    const out = await analyseAccount(
      llm,
      { observe: () => new Promise(() => {}), heuristics: [heuristic], ownerVerified: true },
      () => {},
      20,
    );
    expect(out.source).toBe('heuristic');
  });
});
