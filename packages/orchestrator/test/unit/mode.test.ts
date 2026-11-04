import { describe, expect, it } from 'vitest';
import { InMemoryControlStore, ModeController } from '../../src';
import { FixedClock } from '@near-autopilot/core/testing';
import { NOW } from '../support/world';
import { throws } from '../support/throws';

const make = (initial = {}) => {
  const store = new InMemoryControlStore(NOW, initial);
  return { store, mode: new ModeController(store, new FixedClock(NOW)) };
};

describe('ModeController', () => {
  it('tighten only ever tightens: a milder or equal request is a no-op', async () => {
    const { mode } = make({ mode: 'read_only', reason: 'drill', changedBy: 'ops' });
    expect((await mode.tighten('risk_reduction_only', 'x')).mode).toBe('read_only');
    expect((await mode.tighten('normal', 'x')).mode).toBe('read_only');
    expect((await mode.tighten('read_only', 'x')).reason).toBe('drill'); // equal: unchanged, reason kept
    const n = make();
    expect((await n.mode.tighten('risk_reduction_only', 'volatile')).mode).toBe(
      'risk_reduction_only',
    );
    expect((await n.mode.tighten('normal', 'x')).mode).toBe('risk_reduction_only');
  });

  it('loosening needs an actor and a reason, and resets the counters', async () => {
    const { mode } = make({ mode: 'read_only', consecutiveFailures: 3, blindCycles: 2 });
    expect(await throws(Promise.resolve().then(() => mode.setMode('normal', '', 'ops')))).toBe(
      true,
    );
    expect(await throws(Promise.resolve().then(() => mode.setMode('normal', 'ok', ' ')))).toBe(
      true,
    );
    const s = await mode.setMode('normal', 'checked', 'ops');
    expect(s).toMatchObject({
      mode: 'normal',
      changedBy: 'ops',
      consecutiveFailures: 0,
      blindCycles: 0,
    });
  });

  it('an unreadable store reads as read_only and does not throw', async () => {
    const { store, mode } = make();
    store.failLoads = true;
    expect((await mode.current()).mode).toBe('read_only');
  });

  it('counters and quarantine', async () => {
    const { mode } = make();
    await mode.recordExecution(false);
    await mode.recordExecution(false);
    expect((await mode.current()).consecutiveFailures).toBe(2);
    await mode.recordExecution(true);
    expect((await mode.current()).consecutiveFailures).toBe(0);
    await mode.recordBlindCycle(true);
    await mode.recordBlindCycle(false);
    expect((await mode.current()).blindCycles).toBe(0);
    await mode.quarantine('capital-allocator', 'bad');
    expect(Object.keys((await mode.current()).quarantined)).toEqual(['capital-allocator']);
    expect(
      await throws(Promise.resolve().then(() => mode.releaseAgent('capital-allocator', ''))),
    ).toBe(true);
    await mode.releaseAgent('capital-allocator', 'ops');
    expect((await mode.current()).quarantined).toEqual({});
  });
});
