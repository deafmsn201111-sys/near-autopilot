import { describe, expect, it } from 'vitest';
import { makeWorld, NOW } from '../support/world';
import { throws } from '../support/throws';

const watch = { collateralNear: 100, debtUsdt: 230 };

describe('scenario: idempotency', () => {
  it('the same cycle key twice -> the second call replays the stored outcome and does nothing', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    const first = await w.orchestrator.runCycle('cycle-A');
    expect(first.status).toBe('executed');
    const again = await w.orchestrator.runCycle('cycle-A');
    expect(again.status).toBe('duplicate_cycle');
    expect(again.replayed).toBe(true);
    expect(w.spies.broadcasts).toBe(1);
    expect(w.spies.execute).toBe(1);
    expect(await w.types()).toContain('cycle.replayed');
  });

  it('replaying a NO-ACTION cycle is also a no-op', async () => {
    const w = makeWorld();
    await w.orchestrator.runCycle('k');
    const again = await w.orchestrator.runCycle('k');
    expect(again.status).toBe('duplicate_cycle');
    expect(w.spies.quotes).toBe(0);
  });

  it('two overlapping calls in one process: exactly one runs, the other is told so', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    const [a, b] = await Promise.all([
      w.orchestrator.runCycle('same'),
      w.orchestrator.runCycle('same'),
    ]);
    expect([a.status, b.status].sort()).toEqual(['cycle_in_progress', 'executed']);
    expect(w.spies.broadcasts).toBe(1);

    const w2 = makeWorld({ lending: watch, executor: 'live' });
    const [c, d] = await Promise.all([
      w2.orchestrator.runCycle('one'),
      w2.orchestrator.runCycle('two'),
    ]);
    expect([c.status, d.status]).toContain('cycle_in_progress');
    expect(w2.spies.broadcasts).toBe(1);
  });

  it('a cycle that died BEFORE touching the executor is safely taken over after the timeout, not before', async () => {
    const w = makeWorld({ lending: watch });
    await w.idempotency.begin('crashed', NOW, 300); // claimed, then the process died
    w.clock.advanceSeconds(120);
    const early = await w.orchestrator.runCycle('crashed');
    expect(early.status).toBe('cycle_in_progress');
    expect(w.spies.execute).toBe(0);

    w.clock.advanceSeconds(200); // now 320s since the claim
    const late = await w.orchestrator.runCycle('crashed');
    expect(late.status).toBe('dry_run');
    expect(
      (await w.audit.entries()).find((e) => e.type === 'cycle.started')?.payload['tookOver'],
    ).toBe(true);
  });

  it('a cycle that died AFTER execution started is never re-run: in-doubt, read-only, a human is paged', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    await w.idempotency.begin('mid-flight', NOW, 300);
    await w.idempotency.markExecutionStarted('mid-flight', 'some-action');
    w.clock.advanceSeconds(10_000); // far beyond any timeout
    const r = await w.orchestrator.runCycle('mid-flight');
    expect(r.status).toBe('execution_in_doubt');
    expect(w.spies.execute).toBe(0);
    expect(w.spies.broadcasts).toBe(0);
    expect((await w.orchestrator.controlState()).mode).toBe('read_only');
    expect(w.events.find((e) => e.code === 'IN_DOUBT_EXECUTION')?.severity).toBe('page');
  });

  it('a broadcast that throws leaves the outcome UNKNOWN: in-doubt, frozen, and nothing is retried', async () => {
    const w = makeWorld({ lending: watch, executor: 'live', broadcast: 'throw' });
    const r = await w.orchestrator.runCycle('c1');
    expect(r.status).toBe('execution_in_doubt');
    expect(w.spies.broadcasts).toBe(1);
    expect((await w.orchestrator.controlState()).mode).toBe('read_only');

    const next = await w.orchestrator.runCycle('c2');
    expect(next.status).toBe('read_only');
    expect(w.spies.broadcasts).toBe(1); // never sent a second time
    expect(w.codes()).toContain('IN_DOUBT_EXECUTION');
  });

  it('an executor that crashes after being called is also in doubt (not retried, not assumed to have failed)', async () => {
    const w = makeWorld({ lending: watch, executorThrows: true });
    const r = await w.orchestrator.runCycle('crash');
    expect(r.status).toBe('execution_in_doubt');
    expect((await w.orchestrator.controlState()).mode).toBe('read_only');
    expect(w.events.find((e) => e.code === 'IN_DOUBT_EXECUTION')?.message).toBe(
      'execution result unknown; automation frozen until reconciled',
    );
    expect((await w.orchestrator.runCycle('after')).status).toBe('read_only');
    expect(w.spies.execute).toBe(1);
  });

  it('an in-doubt execution stays frozen until a human reconciles AND releases read-only; both are audited with an actor', async () => {
    const w = makeWorld({ lending: watch, executor: 'live', broadcast: 'throw' });
    await w.orchestrator.runCycle('c1');

    expect(await throws(w.orchestrator.reconcile('c1', '', 'checked explorer'))).toBe(true);
    await w.orchestrator.reconcile(
      'c1',
      'ops@example.com',
      'explorer shows the transfer did not land',
    );
    // Reconciling alone does not resume automation.
    expect((await w.orchestrator.runCycle('c2')).status).toBe('read_only');

    expect(await throws(w.orchestrator.setMode('normal', 'resume', ''))).toBe(true);
    await w.orchestrator.setMode('normal', 'verified on chain', 'ops@example.com');
    const types = await w.types();
    expect(types).toContain('cycle.reconciled');
    expect(types).toContain('mode.changed');
    // The in-doubt repay is still recorded as in flight, so it is NOT repeated just because a human released read-only:
    // the same risk reduction (or an alternative) waits for a snapshot taken after it, or for the dedupe window to pass.
    const r = await w.orchestrator.runCycle('c3');
    expect(r.status).toBe('no_action');
    expect(r.decision?.rejected.every((x) => x.code === 'AWAITING_FRESH_STATE')).toBe(true);
    expect(w.spies.broadcasts).toBe(1);
  });

  it('while ANY other cycle is in doubt, new cycles refuse to act even if the mode were somehow reset', async () => {
    const w = makeWorld({ lending: watch, executor: 'live', broadcast: 'throw' });
    await w.orchestrator.runCycle('c1');
    await w.control.save({ ...(await w.control.load()), mode: 'normal' }); // someone loosened the stored mode without reconciling
    const before = w.spies.broadcasts;
    const r = await w.orchestrator.runCycle('c2');
    expect(r.status).toBe('read_only');
    expect(w.spies.broadcasts).toBe(before);
    expect((await w.orchestrator.controlState()).mode).toBe('read_only'); // the system re-tightened it
  });

  it('the same economic action under different cycle keys is executed once (action-level idempotency)', async () => {
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 40 }, executor: 'live' });
    const a = await w.orchestrator.runCycle('x1');
    const b = await w.orchestrator.runCycle('x2');
    expect(a.status).toBe('executed');
    expect(b.status).toBe('no_action');
    expect(b.decision?.rejected.map((r) => r.code)).toEqual(['DUPLICATE_ACTION']);
    expect(w.spies.broadcasts).toBe(1);
  });

  it('after the dedupe window the same trade is allowed again', async () => {
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 40 }, executor: 'live' });
    await w.orchestrator.runCycle('x1');
    w.clock.advanceSeconds(901);
    const b = await w.orchestrator.runCycle('x2');
    expect(b.status).toBe('executed');
    expect(w.spies.broadcasts).toBe(2);
  });

  it('dry-run results do not block a later real attempt (only in-flight, executed and pending actions do)', async () => {
    const dry = makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });
    expect((await dry.orchestrator.runCycle('d1')).status).toBe('dry_run');
    expect((await dry.orchestrator.runCycle('d2')).status).toBe('dry_run');
  });

  it('a FAILED action is not deduplicated, so a retry is possible (and counted towards the failure limit)', async () => {
    const w = makeWorld({
      lending: null,
      yields: { near: 2, usdt: 40 },
      executor: 'live',
      broadcast: 'failure',
    });
    expect((await w.orchestrator.runCycle('f1')).status).toBe('execution_failed');
    expect((await w.orchestrator.runCycle('f2')).status).toBe('execution_failed');
    expect((await w.orchestrator.controlState()).consecutiveFailures).toBe(2);
  });
});
