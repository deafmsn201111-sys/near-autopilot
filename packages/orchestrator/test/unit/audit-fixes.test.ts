/**
 * Regression tests for defects found in the 2026-11 audit. Each block names the defect it pins down.
 */
import { describe, expect, it } from 'vitest';
import { accountId, type TokenId, type UnitPrice } from '@near-autopilot/core';
import { FixedClock } from '@near-autopilot/core/testing';
import {
  assessRisk,
  checkDataQuality,
  InMemoryControlStore,
  MarketIntelligenceAgent,
  MAX_PROPOSALS_PER_OUTPUT,
  ModeController,
  parseAgentOutput,
  type AgentObservation,
} from '../../src';
import { ALICE, NOW, USDT as USDT_ID, WNEAR as WNEAR_ID, makeWorld } from '../support/world';

describe('data guard: an invalid market timestamp is not "fresh"', () => {
  it('flags it and marks market data unusable (NaN used to compare false against every limit)', () => {
    const w = makeWorld();
    const q = checkDataQuality({
      now: NOW,
      expectedAccount: ALICE,
      snapshot: w.buildSnapshot(),
      market: { ...w.buildMarket(), asOf: new Date(Number.NaN) },
      config: w.config,
    });
    expect(q.marketUsable).toBe(false);
    expect(q.issues).toContainEqual(
      expect.objectContaining({ detail: 'market timestamp is invalid' }),
    );
  });
});

describe('mode controller: an unreadable store is never overwritten with the synthetic fail-safe state', () => {
  const make = () => {
    const store = new InMemoryControlStore(NOW, {
      quarantined: { 'capital-allocator': { since: NOW, reason: 'injection' } },
      consecutiveFailures: 2,
    });
    return { store, mode: new ModeController(store, new FixedClock(NOW)) };
  };

  it('system updates during an outage stay in memory; the real state survives', async () => {
    const { store, mode } = make();
    store.failLoads = true;
    expect((await mode.recordBlindCycle(true)).mode).toBe('read_only');
    await mode.recordExecution(true);
    store.failLoads = false;
    const after = await mode.current();
    expect(after.quarantined['capital-allocator']?.reason).toBe('injection');
    expect(after.consecutiveFailures).toBe(2);
    expect(after.mode).toBe('normal');
  });

  it('an operator emergency read-only is still persisted during an outage', async () => {
    const { store, mode } = make();
    store.failLoads = true;
    await mode.engageReadOnly('incident', 'ops');
    store.failLoads = false;
    expect((await mode.current()).mode).toBe('read_only');
  });
});

describe('orchestrator: repeated missing snapshots page GUARDIAN_BLIND', () => {
  it('escalates from warn to page after staleCyclesBeforePage cycles without any snapshot', async () => {
    const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 230 } });
    w.state.snapshotFails = true;
    for (let i = 0; i < 3; i += 1) await w.orchestrator.runCycle(w.nextKey());
    const sev = w.events
      .filter((e) => e.code === 'SNAPSHOT_UNAVAILABLE' || e.code === 'GUARDIAN_BLIND')
      .map((e) => `${e.code}:${e.severity}`);
    expect(sev).toEqual([
      'SNAPSHOT_UNAVAILABLE:warn',
      'SNAPSHOT_UNAVAILABLE:warn',
      'GUARDIAN_BLIND:page',
    ]);
    expect(w.spies.execute).toBe(0);
  });
});

describe('market intelligence: stays inside the envelope cap instead of losing every signal', () => {
  it('with many stressed tokens it keeps the most severe signals and the output still parses', async () => {
    const w = makeWorld();
    const price: UnitPrice = { multiplier: 10_000n, decimals: 10 };
    const skewed: UnitPrice = { multiplier: 12_000n, decimals: 10 }; // 2000 bps divergence -> severity 5
    const tokens: TokenId[] = Array.from({ length: 6 }, (_, i) => accountId(`t${i}.near`));
    const snapshot = {
      ...w.buildSnapshot(),
      walletBalances: tokens.map((token) => ({ token, raw: 1n })),
      prices: new Map(tokens.map((t) => [t, price])),
    };
    const market = {
      ...w.buildMarket(),
      referencePrices: new Map(tokens.map((t) => [t, skewed])),
      // t0 gets the mildest volatility signal (severity 3); everything else is severity 5.
      volatility24hBps: new Map(tokens.map((t, i) => [t, i === 0 ? 1500 : 7000])),
    };
    const obs: AgentObservation = {
      now: NOW,
      accountId: ALICE,
      snapshot,
      market,
      risk: assessRisk(snapshot, w.config),
      config: w.config,
    };
    const raw = await new MarketIntelligenceAgent().propose(obs);
    const parsed = parseAgentOutput('market-intelligence', JSON.stringify(raw));
    expect(parsed.proposals).toHaveLength(MAX_PROPOSALS_PER_OUTPUT);
    expect(parsed.proposals.every((p) => p.proposal.kind === 'market.signal')).toBe(true);
    const severities = parsed.proposals.map(({ proposal: p }) =>
      p.kind === 'market.signal' ? p.severity : 0,
    );
    expect(Math.min(...severities)).toBe(5);
  });
});

describe('proposal schema: real Rhea DCL ids are accepted', () => {
  const lp = (positionId: string) =>
    JSON.stringify({
      schemaVersion: 1,
      agent: 'lp-optimizer',
      asOf: NOW.toISOString(),
      proposals: [
        { kind: 'lp.reposition', positionId, tickLower: -600, tickUpper: 600, rationale: 'x' },
      ],
    });

  it('accepts pool|pool|fee#n position ids and still refuses whitespace and quotes', () => {
    const id = 'usdt.fakes.testnet|wrap.testnet|2000#17';
    expect(parseAgentOutput('lp-optimizer', lp(id)).proposals).toHaveLength(1);
    expect(parseAgentOutput('lp-optimizer', lp('a b')).proposals).toHaveLength(0);
    expect(parseAgentOutput('lp-optimizer', lp('a"b')).proposals).toHaveLength(0);
  });
});

describe('decision engine: a de-risk that restores the target outranks a cheaper partial fix', () => {
  it('prefers the full collateral top-up over a partial repay capped by the wallet', async () => {
    const { decide, targetHfWad } = await import('../../src');
    const { buildInput, prop } = await import('../support/inputs');
    const { USDT, WNEAR, near, usdt } = await import('../support/world');
    // Debt 230 USDt vs 100 NEAR collateral; the wallet holds only 10 USDt (a repay cannot reach the target)
    // but plenty of NEAR (a top-up can).
    const w = makeWorld({
      lending: { collateralNear: 100, debtUsdt: 230 },
      wallet: { near: 100, usdt: 10 },
    });
    const repay = prop('liquidation-guardian', {
      kind: 'lending.repay',
      token: USDT,
      amount: usdt(10),
      rationale: 'r',
    });
    const topUp = prop('liquidation-guardian', {
      kind: 'lending.supply_collateral',
      token: WNEAR,
      amount: near(100),
      rationale: 'r',
    });
    const d = decide(buildInput([repay, topUp], w));
    const kinds = d.ranked.map((c) => c.action.kind);
    expect(kinds[0]).toBe('lending.supply_collateral');
    const target = targetHfWad(w.config);
    const first = d.ranked[0]?.riskEffect?.hfAfterWad;
    expect(first === null || (first ?? 0n) >= target).toBe(true);
    const partial = d.ranked.find((c) => c.action.kind === 'lending.repay');
    expect(partial ? (partial.riskEffect?.hfAfterWad ?? 0n) < target : true).toBe(true);
  });
});

describe('capital allocator: the drift threshold looks at the real drift, not the turnover-capped move', () => {
  it('still rebalances when maxTurnoverBps is below driftThresholdBps', async () => {
    const { CapitalAllocatorAgent } = await import('../../src');
    const { WNEAR, USDT } = await import('../support/world');
    const w = makeWorld({
      lending: null,
      wallet: { near: 100, usdt: 500 }, // $500 / $500
      yields: { near: 2, usdt: 10 }, // the allocator wants (much) more USDt
      config: {
        allocation: {
          assets: [{ token: WNEAR }, { token: USDT }],
          driftThresholdBps: 500,
          maxTurnoverBps: 300,
        },
      },
    });
    const snapshot = w.buildSnapshot();
    const obs: AgentObservation = {
      now: NOW,
      accountId: ALICE,
      snapshot,
      market: w.buildMarket(),
      risk: assessRisk(snapshot, w.config),
      config: w.config,
    };
    const parsed = parseAgentOutput(
      'capital-allocator',
      JSON.stringify(await new CapitalAllocatorAgent().propose(obs), (_k: string, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    );
    expect(parsed.proposals.map((p) => p.proposal.kind)).toEqual(['allocation.swap']);
  });
});

describe('capital allocator: deposits idle tokens into Burrow when enabled', () => {
  const world = (supplyIdle: boolean, usdt: number) =>
    makeWorld({
      lending: null,
      wallet: { near: 0, usdt },
      yields: { near: 2, usdt: 10 },
      config: { allocation: { assets: [{ token: WNEAR_ID }, { token: USDT_ID }], supplyIdle } },
    });
  it('proposes a supply of the idle, best-yielding token, capped at the per-action limit, and it is executed dry-run', async () => {
    const w = world(true, 500); // $500 USDt idle at 10 %
    const report = await w.orchestrator.runCycle('supply-1');
    expect(report.decision?.ranked[0]?.action).toMatchObject({
      kind: 'lending.supply',
      token: USDT_ID,
    });
    // capped at maxSwapUsd ($100) worth of USDt
    const action = report.decision?.ranked[0]?.action as { amount: bigint } | undefined;
    expect(action?.amount).toBe(100n * 10n ** 6n);
    expect(report.status).toBe('dry_run');
  });
  it('is off by default, and a deposit too small to clear the hurdle is rejected as BELOW_HURDLE', async () => {
    const off = await world(false, 500).orchestrator.runCycle('supply-off');
    expect(off.decision?.ranked.some((r) => r.action.kind === 'lending.supply') ?? false).toBe(
      false,
    );
    const small = await world(true, 3).orchestrator.runCycle('supply-small'); // $3 idle: cents of yield
    expect(small.decision?.rejected.find((r) => r.kind === 'lending.supply')?.code).toBe(
      'BELOW_HURDLE',
    );
  });
});

describe('capital allocator: proposes only along an allowlisted route', () => {
  const run = async (swapPairs: AgentObservation['swapPairs'], yields = { near: 2, usdt: 10 }) => {
    const { CapitalAllocatorAgent } = await import('../../src');
    const { WNEAR, USDT } = await import('../support/world');
    const USDC = accountId('usdc.near');
    const w = makeWorld({
      lending: null,
      wallet: { near: 100, usdt: 0 },
      yields,
      config: {
        allocation: {
          assets: [{ token: WNEAR }, { token: USDT }, { token: USDC }],
          driftThresholdBps: 500,
          maxTurnoverBps: 2500,
        },
      },
    });
    const snapshot = w.buildSnapshot();
    const market = w.buildMarket();
    const prices = new Map(snapshot.prices);
    prices.set(USDC, prices.get(USDT) as UnitPrice);
    const yieldsWad = new Map(market.estimatedYieldWad);
    yieldsWad.set(USDC, 9n * 10n ** 16n); // 9 %: a little below USDt (10 %)
    const obs: AgentObservation = {
      now: NOW,
      accountId: ALICE,
      snapshot: { ...snapshot, prices },
      market: { ...market, estimatedYieldWad: yieldsWad, referencePrices: prices },
      risk: assessRisk(snapshot, w.config),
      config: w.config,
      ...(swapPairs ? { swapPairs } : {}),
    };
    const out = (await new CapitalAllocatorAgent().propose(obs)) as {
      proposals: {
        kind: string;
        tokenIn?: string;
        tokenOut?: string;
        reasonCode?: string;
        rationale: string;
      }[];
    };
    return { out: out.proposals[0], WNEAR, USDT, USDC };
  };

  it('without a route to the best asset it picks the best one it CAN reach (USDC), not USDt', async () => {
    const { WNEAR, USDC } = await import('../support/world').then(async (m) => ({
      WNEAR: m.WNEAR,
      USDC: accountId('usdc.near'),
    }));
    const { out } = await run([[WNEAR, USDC]]);
    expect(out).toMatchObject({ kind: 'allocation.swap', tokenIn: WNEAR, tokenOut: USDC });
  });

  it('with no route at all it says so instead of proposing a swap that can never be quoted', async () => {
    const { out } = await run([]);
    expect(out).toMatchObject({ kind: 'no_action', reasonCode: 'no_edge' });
    expect(out?.rationale).toMatch(/no allowlisted pool connects/);
  });

  it('without route information it behaves as before (best yield)', async () => {
    const { out, USDT } = await run(undefined);
    expect(out).toMatchObject({ kind: 'allocation.swap', tokenOut: USDT });
  });
});

describe("agents explain missing market data with the provider's reasons", () => {
  const observe = async (market: AgentObservation['market'], w: ReturnType<typeof makeWorld>) => {
    const snapshot = w.buildSnapshot();
    return {
      now: NOW,
      accountId: ALICE,
      snapshot,
      market,
      risk: assessRisk(snapshot, w.config),
      config: w.config,
    } satisfies AgentObservation;
  };

  it('the Capital Allocator names each token without a yield and why, and proposes nothing', async () => {
    const { CapitalAllocatorAgent } = await import('../../src');
    const { WNEAR, USDT } = await import('../support/world');
    const w = makeWorld({
      lending: null,
      wallet: { near: 100, usdt: 500 },
      config: { allocation: { assets: [{ token: WNEAR }, { token: USDT }] } },
    });
    const base = w.buildMarket();
    const market = {
      ...base,
      estimatedYieldWad: new Map([[USDT, 10n ** 17n]]),
      notes: { yield: new Map([[WNEAR, 'INSUFFICIENT_LIQUIDITY: utilisation 100.00 %']]) },
    };
    const out = JSON.stringify(
      await new CapitalAllocatorAgent().propose(await observe(market, w)),
      (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    const parsed = parseAgentOutput('capital-allocator', out);
    expect(parsed.proposals.map((p) => p.proposal.kind)).not.toContain('allocation.swap');
    expect(out).toContain(
      `missing yield estimate: ${WNEAR} (INSUFFICIENT_LIQUIDITY: utilisation 100.00 %)`,
    );
  });

  it('the LP Optimizer reports the pools observed and why none is usable', async () => {
    const { LpOptimizerAgent } = await import('../../src');
    const w = makeWorld({ lending: null });
    const market = {
      ...w.buildMarket(),
      lpPositions: [],
      notes: { lp: '2 pool(s) observed, 0 usable; rejected: UNVERIFIED_POOL' },
    };
    const out = JSON.stringify(await new LpOptimizerAgent().propose(await observe(market, w)));
    expect(out).toContain(
      'no liquidity positions to evaluate; 2 pool(s) observed, 0 usable; rejected: UNVERIFIED_POOL',
    );
  });
});
