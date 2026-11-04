import { describe, expect, it } from 'vitest';
import {
  InMemoryAuditLog,
  InMemoryControlStore,
  InMemoryIdempotencyStore,
  entryHash,
  verifyChain,
  type AuditEntry,
} from '../../src';
import { NOW } from '../support/world';

const at = (s = 0) => new Date(NOW.getTime() + s * 1000);
const input = (type: string, payload: Record<string, unknown> = {}) => ({
  at: NOW,
  type,
  cycleKey: 'c',
  decisionId: null,
  payload,
});

describe('InMemoryAuditLog (hash chain)', () => {
  const filled = async (n = 5) => {
    const log = new InMemoryAuditLog();
    for (let i = 0; i < n; i += 1) await log.append(input(`t${i}`, { i }));
    return log;
  };

  it('starts at seq 1 from a zero genesis hash and links every entry to the previous one', async () => {
    const log = await filled();
    const e = await log.entries();
    expect(e[0]).toMatchObject({ seq: 1, prevHash: '0'.repeat(64) });
    for (let i = 1; i < e.length; i += 1) expect(e[i]!.prevHash).toBe(e[i - 1]!.hash);
    expect(await log.verify()).toEqual({ ok: true });
  });

  it('an empty log verifies', async () => {
    expect(await new InMemoryAuditLog().verify()).toEqual({ ok: true });
  });

  it('detects an edit to ANY field of ANY entry', async () => {
    const patches: Partial<AuditEntry>[] = [
      { type: 'forged' },
      { payload: { i: 999 } },
      { at: at(1) },
      { cycleKey: 'other' },
      { decisionId: 'd' },
      { hash: 'f'.repeat(64) },
      { prevHash: 'e'.repeat(64) },
      { seq: 99 },
    ];
    for (let idx = 0; idx < 5; idx += 1) {
      for (const patch of patches) {
        const log = await filled();
        log.tamper(idx, patch);
        const r = await log.verify();
        expect([idx, JSON.stringify(Object.keys(patch)), r.ok]).toEqual([
          idx,
          JSON.stringify(Object.keys(patch)),
          false,
        ]);
      }
    }
  });

  it('detects deletion (including of the first and last entries being re-numbered) and reordering', async () => {
    const e = [...(await (await filled()).entries())];
    expect(verifyChain([...e.slice(0, 2), ...e.slice(3)]).ok).toBe(false); // middle removed
    expect(verifyChain(e.slice(1)).ok).toBe(false); // head removed
    expect(verifyChain([e[1]!, e[0]!, ...e.slice(2)]).ok).toBe(false); // reordered
    expect(verifyChain(e.slice(0, -1)).ok).toBe(true); // truncating the tail is NOT detectable by a chain alone
  });

  it('entryHash depends on the previous hash and on every content field', () => {
    const base = { seq: 1, at: NOW, type: 't', cycleKey: 'c', decisionId: null, payload: { a: 1 } };
    const h = entryHash('0'.repeat(64), base);
    expect(entryHash('1'.repeat(64), base)).not.toBe(h);
    for (const patch of [
      { seq: 2 },
      { at: at(1) },
      { type: 'u' },
      { cycleKey: 'd' },
      { decisionId: 'x' },
      { payload: { a: 2 } },
    ]) {
      expect(entryHash('0'.repeat(64), { ...base, ...patch })).not.toBe(h);
    }
    expect(entryHash('0'.repeat(64), { ...base, payload: { a: 1 } })).toBe(h);
  });

  it('payload key order does not change the hash (canonical JSON)', () => {
    const a = entryHash('0'.repeat(64), {
      seq: 1,
      at: NOW,
      type: 't',
      cycleKey: null,
      decisionId: null,
      payload: { a: 1, b: 2 },
    });
    const b = entryHash('0'.repeat(64), {
      seq: 1,
      at: NOW,
      type: 't',
      cycleKey: null,
      decisionId: null,
      payload: { b: 2, a: 1 },
    });
    expect(a).toBe(b);
  });

  it('concurrent appends stay gap-free and valid', async () => {
    const log = new InMemoryAuditLog();
    await Promise.all(Array.from({ length: 50 }, (_, i) => log.append(input('c', { i }))));
    const e = await log.entries();
    expect(e.map((x) => x.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(await log.verify()).toEqual({ ok: true });
  });

  it('a failed append stores nothing and leaves the chain intact', async () => {
    const log = await filled(3);
    log.failAppends = true;
    let threw = false;
    try {
      await log.append(input('x'));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect((await log.entries()).length).toBe(3);
    log.failAppends = false;
    await log.append(input('y'));
    expect(await log.verify()).toEqual({ ok: true });
  });

  it('entries() returns copies: mutating them cannot alter the log', async () => {
    const log = await filled(2);
    const e = (await log.entries()) as AuditEntry[];
    (e[0] as { payload: Record<string, unknown> }).payload['i'] = 'changed';
    expect(await log.verify()).toEqual({ ok: true });
    expect((await log.entries())[0]!.payload['i']).toBe(0);
  });
});

describe('InMemoryControlStore', () => {
  it('returns copies and persists saves', async () => {
    const s = new InMemoryControlStore(NOW);
    const a = await s.load();
    (a as { mode: string }).mode = 'read_only';
    expect((await s.load()).mode).toBe('normal');
    await s.save({ ...a, mode: 'read_only' });
    expect((await s.load()).mode).toBe('read_only');
  });

  it('can be made unreadable', async () => {
    const s = new InMemoryControlStore(NOW);
    s.failLoads = true;
    let threw = false;
    try {
      await s.load();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('begin is exclusive: of many simultaneous claimers exactly one wins', async () => {
    const s = new InMemoryIdempotencyStore();
    const results = await Promise.all(Array.from({ length: 20 }, () => s.begin('k', NOW, 300)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('a completed key is never claimable again, and its summary is returned', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.begin('k', NOW, 300);
    await s.complete('k', { outcome: 'dry_run', decisionId: 'd', executed: false, detail: 'ok' });
    const again = await s.begin('k', at(100_000), 300);
    expect(again.claimed).toBe(false);
    expect(!again.claimed && again.existing.summary?.outcome).toBe('dry_run');
  });

  it('takeover: only when nothing was executed AND the claim is at least the timeout old', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.begin('k', NOW, 300);
    expect((await s.begin('k', at(299), 300)).claimed).toBe(false);
    const late = await s.begin('k', at(300), 300);
    expect(late).toEqual({ claimed: true, tookOver: true });
  });

  it('never taken over once execution started, however old', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.begin('k', NOW, 300);
    await s.markExecutionStarted('k', 'a');
    const r = await s.begin('k', at(1_000_000), 300);
    expect(r.claimed).toBe(false);
    expect(!r.claimed && r.existing.executionStartedFor).toBe('a');
  });

  it('inDoubt lists started-but-not-completed cycles, and not completed ones', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.begin('a', NOW, 300);
    await s.begin('b', NOW, 300);
    await s.begin('c', NOW, 300);
    await s.markExecutionStarted('a', 'x');
    await s.markExecutionStarted('b', 'y');
    await s.complete('b', { outcome: 'executed', decisionId: null, executed: true, detail: '' });
    await s.markNeedsReconciliation('a');
    expect((await s.inDoubt()).map((c) => c.key)).toEqual(['a']);
  });

  it('recentActions returns only actions inside the window, and updateAction changes status and hash', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.recordAction({
      actionKey: 'a',
      kind: 'lending.repay',
      decisionId: 'd1',
      cycleKey: 'c1',
      status: 'in_flight',
      at: at(-1000),
      txHash: null,
    });
    await s.recordAction({
      actionKey: 'b',
      kind: 'allocation.swap',
      decisionId: 'd2',
      cycleKey: 'c2',
      status: 'in_flight',
      at: at(-10),
      txHash: null,
    });
    expect((await s.recentActions(at(-100))).map((a) => a.actionKey)).toEqual(['b']);
    await s.updateAction('b', 'd2', { status: 'executed', txHash: 'h' });
    expect((await s.recentActions(at(-100)))[0]).toMatchObject({
      actionKey: 'b',
      status: 'executed',
      kind: 'allocation.swap',
    });
    await s.updateAction('b', 'wrong-decision', { status: 'failed', txHash: null }); // must not touch other decisions' records
    expect((await s.recentActions(at(-100)))[0]!.status).toBe('executed');
  });
});
