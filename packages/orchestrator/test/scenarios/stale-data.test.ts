import { describe, expect, it } from 'vitest';
import { scriptedAgent, makeWorld, USDT, WNEAR, near, NOW } from '../support/world';
import { DEFAULT_COLLATERAL_STRESS } from '@near-autopilot/financial-engine';
import { LiquidationGuardianAgent } from '../../src';

const watchPosition = { collateralNear: 100, debtUsdt: 230 }; // HF ~1.37: the guardian wants to repay

describe('scenario: stale-data protection', () => {
  it('a stale snapshot blocks everything, even a repayment the guardian badly wants', async () => {
    const w = makeWorld({ lending: watchPosition, snapshotAgeSeconds: 61 });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision?.reasons).toEqual(['DATA_NOT_FRESH']);
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).toContain('SNAPSHOT_STALE');
    expect(w.spies).toMatchObject({ plans: 0, evaluate: 0, approve: 0, execute: 0 });
  });

  it('stale oracle prices block everything', async () => {
    const w = makeWorld({ lending: watchPosition, pricesAgeSeconds: 120 });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).toContain('PRICES_STALE');
    expect(w.spies.execute).toBe(0);
  });

  it('data exactly at the limit is accepted, one second past it is not', async () => {
    const ok = makeWorld({ lending: watchPosition, snapshotAgeSeconds: 60, pricesAgeSeconds: 60 });
    expect((await ok.orchestrator.runCycle(ok.nextKey())).status).toBe('dry_run');
    const late = makeWorld({ lending: watchPosition, snapshotAgeSeconds: 61 });
    expect((await late.orchestrator.runCycle(late.nextKey())).status).toBe('no_action');
  });

  it('timestamps from the future are treated as corrupt, not as "very fresh"', async () => {
    const w = makeWorld({ lending: watchPosition, snapshotAgeSeconds: -120 });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).toContain('FUTURE_TIMESTAMP');
    expect(r.status).toBe('no_action');
    expect(w.spies.execute).toBe(0);
  });

  it('a slow read is not future-dated: freshness is judged when the observation completes (regression)', async () => {
    // A public RPC took ~13 s for a snapshot; judged against the cycle's start time, the snapshot looked
    // 13 s in the future and every cycle was blocked with FUTURE_TIMESTAMP.
    const w = makeWorld({ lending: watchPosition, snapshotTakesSeconds: 13 });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).not.toContain('FUTURE_TIMESTAMP');
    expect(r.status).toBe('dry_run');
  });

  it('a snapshot for a different account is refused', async () => {
    const w = makeWorld({ lending: watchPosition });
    w.state.accountOverride = 'mallory.near';
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).toContain('ACCOUNT_MISMATCH');
    expect(w.spies.execute).toBe(0);
  });

  it('a borrowing position that cannot be fully priced is blocked: unknown is never treated as healthy', async () => {
    const w = makeWorld({ lending: watchPosition });
    w.prices.delete(USDT);
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('unknown');
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).toContain('MISSING_PRICES');
    expect(w.spies.execute).toBe(0);
    expect(w.codes()).toContain('POSITION_UNVALUABLE');
  });

  it('stale MARKET data blocks discretionary trades but not de-risking, which depends only on the snapshot', async () => {
    const w = makeWorld({ lending: watchPosition });
    w.state.market = { ...w.buildMarket(), asOf: new Date(NOW.getTime() - 3600_000) };
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.dataQuality.issues.map((i) => i.code)).toContain('MARKET_STALE');
    expect(r.status).toBe('dry_run');
    expect(r.decision?.ranked[0]?.action.kind).toBe('lending.repay');

    const calm = makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });
    calm.state.market = { ...calm.buildMarket(), asOf: new Date(NOW.getTime() - 3600_000) };
    const r2 = await calm.orchestrator.runCycle(calm.nextKey());
    expect(r2.decision?.rejected.map((x) => x.code)).toEqual(['MARKET_DATA_STALE']);
    expect(calm.spies.execute).toBe(0);
  });

  it('time-of-check/time-of-use: data that goes stale WHILE the agents think is caught before execution', async () => {
    // Setup check: without the delay the very same cycle executes, so the abort below is caused by the delay alone.
    const baseline = makeWorld({ lending: watchPosition });
    expect((await baseline.orchestrator.runCycle(baseline.nextKey())).status).toBe('dry_run');

    // Now make the delay long enough that the snapshot expires after the policy verdict but before execution.
    const late = makeWorld({ lending: watchPosition, agents: [new LiquidationGuardianAgent()] });
    const originalEvaluate = late.engine.evaluate.bind(late.engine);
    late.engine.evaluate = (input) => {
      const verdict = originalEvaluate(input);
      late.clock.advanceSeconds(90); // policy evaluation "takes" 90s
      return verdict;
    };
    const r = await late.orchestrator.runCycle(late.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.detail).toContain('went stale');
    expect(late.spies.approve).toBe(0); // no ApprovedPlan was ever minted
    expect(late.spies.execute).toBe(0);
    expect(await late.types()).toContain('execution.aborted');
  });

  it('snapshot provider failure -> no action, a warning, and the blind-cycle counter increments', async () => {
    const w = makeWorld({ lending: watchPosition });
    w.state.snapshotFails = true;
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision).toBeNull();
    expect(w.codes()).toContain('SNAPSHOT_UNAVAILABLE');
    expect((await w.orchestrator.controlState()).blindCycles).toBe(1);
    expect(w.spies.execute).toBe(0);
  });

  it('a guardian that stays blind while a borrow is open escalates from warn to page', async () => {
    const w = makeWorld({ lending: watchPosition, snapshotAgeSeconds: 600 });
    for (let i = 0; i < 3; i += 1) await w.orchestrator.runCycle(w.nextKey());
    const sev = w.events
      .filter((e) => e.code === 'DATA_BLOCKING_WHILE_BORROWING' || e.code === 'GUARDIAN_BLIND')
      .map((e) => `${e.code}:${e.severity}`);
    expect(sev).toEqual([
      'DATA_BLOCKING_WHILE_BORROWING:warn',
      'DATA_BLOCKING_WHILE_BORROWING:warn',
      'GUARDIAN_BLIND:page',
    ]);
    // Fresh data resets the counter.
    w.state.snapshotAgeSeconds = 0;
    await w.orchestrator.runCycle(w.nextKey());
    expect((await w.orchestrator.controlState()).blindCycles).toBe(0);
  });

  it('the orchestrator check is independent of, and stricter than, the policy engine freshness rule', async () => {
    // Policy allows 120s; the orchestrator allows 60s. At 90s the orchestrator stops the cycle before policy is consulted.
    const w = makeWorld({ lending: watchPosition, snapshotAgeSeconds: 90, pricesAgeSeconds: 90 });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(w.spies.evaluate).toBe(0);
    void scriptedAgent;
    void WNEAR;
    void near;
    void DEFAULT_COLLATERAL_STRESS;
  });
});
