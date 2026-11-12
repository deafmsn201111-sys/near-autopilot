import { describe, expect, it } from 'vitest';
import { LlmAgent, type LlmClient } from '../../src';
import { makeWorld, usdt } from '../support/world';

const watch = { collateralNear: 100, debtUsdt: 230 };

/** `needle` must appear in `haystack` in this order (other entries may be interleaved). */
const inOrder = (haystack: string[], needle: string[]): boolean => {
  let i = 0;
  for (const h of haystack) if (h === needle[i]) i += 1;
  return i === needle.length;
};

describe('scenario: decision audit log', () => {
  it('an executing cycle leaves a complete, ordered, hash-chained trail', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    const r = await w.orchestrator.runCycle('audit-1');
    expect(r.status).toBe('executed');
    const types = await w.types();
    expect(
      inOrder(types, [
        'cycle.started',
        'observation',
        'agent.output',
        'decision.act',
        'policy.verdict',
        'execution.started',
        'execution.result',
        'cycle.finished',
      ]),
    ).toBe(true);
    expect(await w.audit.verify()).toEqual({ ok: true });
    const entries = await w.audit.entries();
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1)); // 1-based and gap-free
    expect(new Set(entries.filter((e) => e.type !== 'escalation').map((e) => e.cycleKey))).toEqual(
      new Set(['audit-1']),
    );
  });

  it('every decision, including "do nothing", carries its inputs hash, reasons and the full inputs for replay', async () => {
    const w = makeWorld();
    const r = await w.orchestrator.runCycle('audit-2');
    const entry = (await w.audit.entries()).find((e) => e.type === 'decision.no_action');
    expect(entry?.payload['inputsHash']).toBe(r.decision?.inputsHash);
    expect(entry?.decisionId).toBe(r.decision?.decisionId);
    expect(entry?.payload['inputs']).toBeDefined();
    expect(entry?.payload['reasons']).toEqual(['NOTHING_PROPOSED']);
  });

  it('storing full inputs is optional; the hash is always there', async () => {
    const w = makeWorld({ config: { audit: { storeInputs: false } } });
    await w.orchestrator.runCycle('audit-3');
    const entry = (await w.audit.entries()).find((e) => e.type === 'decision.no_action');
    expect(entry?.payload['inputs']).toBeUndefined();
    expect(String(entry?.payload['inputsHash'])).toHaveLength(64);
  });

  it('the chain detects after-the-fact edits and deletions', async () => {
    const w = makeWorld({ lending: watch });
    await w.orchestrator.runCycle('audit-4');
    expect(await w.audit.verify()).toEqual({ ok: true });
    w.audit.tamper(2, { payload: { forged: true } });
    const res = await w.audit.verify();
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.brokenAtSeq).toBeGreaterThanOrEqual(2);
  });

  it('identical inputs give identical decisions and hashes; changing one input changes both', async () => {
    const a = makeWorld({ lending: watch });
    const b = makeWorld({ lending: watch });
    const c = makeWorld({ lending: { collateralNear: 100, debtUsdt: 231 } });
    const [ra, rb, rc] = [
      await a.orchestrator.runCycle('k'),
      await b.orchestrator.runCycle('k'),
      await c.orchestrator.runCycle('k'),
    ];
    expect(ra.decision?.decisionId).toBe(rb.decision?.decisionId);
    expect(ra.decision?.inputsHash).toBe(rb.decision?.inputsHash);
    expect(rc.decision?.inputsHash).not.toBe(ra.decision?.inputsHash);
    expect(rc.decision?.decisionId).not.toBe(ra.decision?.decisionId);
  });

  describe('the audit log is fail-closed', () => {
    it('if the log is down at the start, nothing happens: aborted, read-only, paged', async () => {
      const w = makeWorld({ lending: watch, executor: 'live' });
      w.audit.failAppends = true;
      const r = await w.orchestrator.runCycle('down');
      expect(r.status).toBe('aborted');
      expect(r.detail).toBe('cycle aborted');
      expect(w.spies).toMatchObject({
        plans: 0,
        evaluate: 0,
        approve: 0,
        execute: 0,
        broadcasts: 0,
      });
      expect((await w.orchestrator.controlState()).mode).toBe('read_only');
      expect(w.events.find((e) => e.code === 'AUDIT_UNAVAILABLE')?.message).toBe(
        'cycle down aborted',
      );
    });

    it('if it fails exactly when the execution is about to be recorded, the transaction is NOT sent', async () => {
      const w = makeWorld({ lending: watch, executor: 'live' });
      const original = w.audit.append.bind(w.audit);
      w.audit.append = async (e) => {
        if (e.type === 'execution.started') throw new Error('disk full');
        return original(e);
      };
      const r = await w.orchestrator.runCycle('almost');
      expect(r.status).toBe('aborted');
      expect(w.spies.broadcasts).toBe(0);
      expect(w.spies.execute).toBe(0);
      expect((await w.orchestrator.controlState()).mode).toBe('read_only');
    });

    it('if the DECISION cannot be recorded, nothing is planned, authorised or sent', async () => {
      const w = makeWorld({ lending: watch, executor: 'live' });
      const original = w.audit.append.bind(w.audit);
      w.audit.append = async (e) => {
        if (e.type.startsWith('decision.')) throw new Error('disk full');
        return original(e);
      };
      const r = await w.orchestrator.runCycle('no-decision-record');
      expect(r.status).toBe('aborted');
      expect(w.spies).toMatchObject({
        plans: 0,
        evaluate: 0,
        approve: 0,
        execute: 0,
        broadcasts: 0,
      });
      expect((await w.orchestrator.controlState()).mode).toBe('read_only');
    });

    it('if it fails only AFTER the transaction (result record), the outcome is reported and the system freezes', async () => {
      const w = makeWorld({ lending: watch, executor: 'live' });
      const original = w.audit.append.bind(w.audit);
      w.audit.append = async (e) => {
        if (e.type === 'execution.result') throw new Error('disk full');
        return original(e);
      };
      const r = await w.orchestrator.runCycle('late');
      expect(r.status).toBe('executed'); // it did happen; we do not pretend otherwise
      expect(w.spies.broadcasts).toBe(1);
      expect((await w.orchestrator.controlState()).mode).toBe('read_only');
      expect(w.events.find((e) => e.code === 'AUDIT_UNAVAILABLE')?.severity).toBe('page');
    });

    it('a failing pager does not stop a de-risk and is itself recorded', async () => {
      const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 290 } });
      w.notifier.fail = true;
      const r = await w.orchestrator.runCycle('pager');
      expect(r.status).toBe('dry_run');
      expect(await w.types()).toContain('escalation.notify_failed');
    });
  });

  it('every policy verdict is stored before the plan is executed', async () => {
    const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 290 } });
    const r = await w.orchestrator.runCycle('verdicts');
    expect(r.status).toBe('dry_run');
    expect(w.verdicts.length).toBeGreaterThan(0);
    expect(w.verdicts[0]).toMatchObject({
      verdict: 'ALLOW',
      cycleKey: 'verdicts',
      executedBefore: 0,
    });
    expect(w.spies.execute).toBe(1);
  });

  it('a verdict that cannot be stored is never acted on', async () => {
    const w = makeWorld({ lending: { collateralNear: 100, debtUsdt: 290 } });
    w.verdictsFail();
    const r = await w.orchestrator.runCycle('verdicts-down');
    expect(w.spies.execute).toBe(0);
    expect(r.status).toBe('aborted');
  });

  it('model output is stored only as a bounded excerpt, never in full', async () => {
    const huge = 'A'.repeat(500_000);
    const client: LlmClient = {
      async complete() {
        return huge;
      },
    };
    const w = makeWorld({
      lending: null,
      agents: [new LlmAgent('market-intelligence', client, 'x')],
    });
    await w.orchestrator.runCycle('big');
    const dump = JSON.stringify(await w.audit.entries());
    expect(dump.length).toBeLessThan(120_000);
    expect(dump).not.toContain('A'.repeat(1000));
  });

  it('secrets never reach the log: the snapshot, plans and results contain no key material', async () => {
    const w = makeWorld({ lending: watch, executor: 'live' });
    await w.orchestrator.runCycle('plain-cycle');
    const dump = JSON.stringify(await w.audit.entries());
    expect(dump).not.toMatch(/private|secret|seed|ed25519:/i);
    void usdt;
  });
});
