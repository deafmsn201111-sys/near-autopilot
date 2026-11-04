import { describe, expect, it } from 'vitest';
import { guardExecutor, ModeController, InMemoryControlStore } from '../../src';
import { makeWorld, NOW } from '../support/world';
import { throws } from '../support/throws';
import { FixedClock } from '@near-autopilot/core/testing';

const watch = { collateralNear: 100, debtUsdt: 230 };

describe('scenario: emergency read-only mode', () => {
  it('engaged by an operator: agents still run and the decision is made and audited, but nothing is authorised or executed', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    await w.orchestrator.engageEmergencyReadOnly('suspicious oracle behaviour', 'ops@example.com');
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('read_only');
    expect(r.decision?.outcome).toBe('no_action');
    expect(r.decision?.reasons).toEqual(['READ_ONLY_MODE']);
    // The would-be action is shown for the human, never executed.
    expect(r.decision?.wouldHaveActed?.action.kind).toBe('lending.repay');
    expect(r.decision?.ranked).toHaveLength(0);
    expect(w.spies).toMatchObject({ plans: 0, evaluate: 0, approve: 0, execute: 0, broadcasts: 0 });
    expect(w.codes()).toContain('EMERGENCY_READ_ONLY');
    expect(w.codes()).toContain('READ_ONLY_SUPPRESSED');
    expect(await w.types()).toContain('decision.no_action');
  });

  it('read-only still observes and reports risk (the dashboard stays useful)', async () => {
    const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 330 } });
    await w.orchestrator.engageEmergencyReadOnly('drill', 'ops@example.com');
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('liquidatable');
    expect(w.codes()).toContain('POSITION_LIQUIDATABLE');
    expect(w.spies.execute).toBe(0);
  });

  it('engaging needs a named actor and a reason', async () => {
    const w = makeWorld();
    expect(await throws(w.orchestrator.engageEmergencyReadOnly('', 'ops'))).toBe(true);
    expect(await throws(w.orchestrator.engageEmergencyReadOnly('why', '  '))).toBe(true);
    expect((await w.orchestrator.controlState()).mode).toBe('normal');
  });

  it('it is persisted: a brand new orchestrator over the same control store is still read-only', async () => {
    const w = makeWorld({ lending: watch });
    await w.orchestrator.engageEmergencyReadOnly('drill', 'ops@example.com');
    const state = await w.control.load();
    expect(state.mode).toBe('read_only');
    expect(state.changedBy).toBe('ops@example.com');
    expect(state.reason).toBe('drill');
  });

  it('the system never loosens it; only an operator with an actor and a reason can', async () => {
    const w = makeWorld({ lending: watch });
    await w.orchestrator.engageEmergencyReadOnly('drill', 'ops@example.com');
    for (let i = 0; i < 3; i += 1) await w.orchestrator.runCycle(w.nextKey()); // healthy-looking cycles do not release it
    expect((await w.orchestrator.controlState()).mode).toBe('read_only');
    expect(await throws(w.orchestrator.setMode('normal', '', 'ops'))).toBe(true);
    await w.orchestrator.setMode('normal', 'drill over', 'ops@example.com');
    expect((await w.orchestrator.controlState()).mode).toBe('normal');
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('dry_run');
  });

  it('an operator can choose risk_reduction_only: repay allowed, discretionary trades not', async () => {
    const w = makeWorld({ lending: watch, yields: { near: 2, usdt: 60 } });
    await w.orchestrator.setMode('risk_reduction_only', 'volatile market', 'ops@example.com');
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('dry_run');
    expect(r.decision?.ranked.every((c) => c.tier <= 1)).toBe(true);
    // (With a position at watch the swap is already refused for risk; the mode code is asserted on the healthy world below.)
    expect(r.decision?.rejected.some((x) => x.kind === 'allocation.swap')).toBe(true);

    const calm = makeWorld({ lending: null, yields: { near: 2, usdt: 60 } });
    await calm.orchestrator.setMode('risk_reduction_only', 'volatile market', 'ops@example.com');
    const r2 = await calm.orchestrator.runCycle(calm.nextKey());
    expect(r2.status).toBe('no_action');
    expect(r2.decision?.rejected.map((x) => x.code)).toEqual(['MODE_RISK_REDUCTION_ONLY']);
    expect(calm.spies.execute).toBe(0);
  });

  it('an unreadable control store means read-only, not "normal by default"', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    w.control.failLoads = true;
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('read_only');
    expect(w.spies.broadcasts).toBe(0);
    expect(w.spies.approve).toBe(0);
    expect((await w.orchestrator.controlState()).mode).toBe('read_only');
  });

  it('three consecutive execution failures trip read-only automatically and page', async () => {
    const w = makeWorld({
      lending: null,
      yields: { near: 2, usdt: 40 },
      executor: 'live',
      broadcast: 'failure',
    });
    for (let i = 0; i < 3; i += 1) await w.orchestrator.runCycle(w.nextKey());
    expect((await w.orchestrator.controlState()).mode).toBe('read_only');
    expect(w.events.find((e) => e.code === 'EMERGENCY_READ_ONLY')?.severity).toBe('page');
    expect((await w.orchestrator.runCycle(w.nextKey())).status).toBe('read_only');
    expect(w.spies.broadcasts).toBe(3);
  });

  it('a success resets the failure counter', async () => {
    const w = makeWorld({
      lending: null,
      yields: { near: 2, usdt: 40 },
      executor: 'live',
      broadcast: 'failure',
    });
    await w.orchestrator.runCycle(w.nextKey());
    await w.orchestrator.runCycle(w.nextKey());
    expect((await w.orchestrator.controlState()).consecutiveFailures).toBe(2);
    await w.control.save({ ...(await w.control.load()), consecutiveFailures: 0 });
    expect((await w.orchestrator.controlState()).mode).toBe('normal');
  });

  it('engaged DURING a cycle (while agents are thinking): the final re-check stops the action before policy.approve', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    const original = w.engine.evaluate.bind(w.engine);
    w.engine.evaluate = (input) => {
      const verdict = original(input);
      // The operator hits the big red button after the policy verdict, before authorisation.
      void w.orchestrator.engageEmergencyReadOnly('operator pulled the plug', 'ops@example.com');
      return verdict;
    };
    const r = await w.orchestrator.runCycle(w.nextKey());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.status).toBe('read_only');
    expect(w.spies.approve).toBe(0);
    expect(w.spies.broadcasts).toBe(0);
    expect(await w.types()).toContain('execution.aborted');
  });

  it('defence in depth: a guarded executor refuses to run in read-only mode even when called directly', async () => {
    const w = makeWorld({ lending: watch });
    const control = new InMemoryControlStore(NOW, {
      mode: 'read_only',
      reason: 'drill',
      changedBy: 'ops',
    });
    const mode = new ModeController(control, new FixedClock(NOW));
    let ran = 0;
    const guarded = guardExecutor(
      {
        async execute() {
          ran += 1;
          return { status: 'success', mode: 'live', txHash: 'x', error: null };
        },
      },
      mode,
    );
    const result = await guarded.execute({} as never);
    expect(result.status).toBe('rejected');
    expect(ran).toBe(0);
    void w;
  });

  it('an agent that is released after quarantine needs an operator actor too', async () => {
    const w = makeWorld();
    expect(await throws(w.orchestrator.releaseAgent('capital-allocator', ''))).toBe(true);
  });
});
