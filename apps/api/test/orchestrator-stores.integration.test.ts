import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  orchestratorControl,
  orchestratorControlHistory,
  runMigrations,
  sql,
  type DatabaseHandle,
} from '@near-autopilot/db';
import { ModeController } from '@near-autopilot/orchestrator';
import { EvidenceStore } from '../src/evidence/store';
import {
  ControlConflictError,
  PgControlStore,
  PgIdempotencyStore,
} from '../src/infra/orchestrator-stores';
import { makeWorld, NOW } from '../../../packages/orchestrator/test/support/world';

/**
 * RESTART AND RACE SAFETY of the durable orchestrator stores, on a real PostgreSQL (skipped unless DATABASE_TEST_URL
 * is set; CI sets it). A "restart" is a new world (new orchestrator, new store objects, same database and scope); a
 * "second process" is a second world on the same scope. The orchestrator scenarios are the package's own test world,
 * with only the two stores swapped for the PostgreSQL ones. Criterion: no failure turns a refused action into an
 * executed one.
 */
const adminUrl = process.env['DATABASE_TEST_URL'];
const CHAIN = 'simulation:mainnet';
const watch = { collateralNear: 100, debtUsdt: 230 }; // HF in the watch band: the guardian proposes a repay

describe.skipIf(!adminUrl)('durable orchestrator state (PostgreSQL)', () => {
  const dbName = `autopilot_stores_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 8 });
    await runMigrations(handle.db);
  });
  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  let n = 0;
  const newScope = () => `test:mainnet:alice.near:s${(n += 1)}-${randomBytes(3).toString('hex')}`;
  /** One orchestrator "process" on `scope`. */
  const processOn = (scope: string, opts: Parameters<typeof makeWorld>[0] = {}) =>
    makeWorld({
      ...opts,
      stores: (clock) => ({
        control: new PgControlStore(handle.db, scope, CHAIN, clock),
        idempotency: new PgIdempotencyStore(handle.db, scope, clock),
      }),
    });

  it('1. an emergency read-only survives a restart, and the restarted process executes nothing', async () => {
    const scope = newScope();
    const before = processOn(scope, { lending: watch, executor: 'live' });
    await before.orchestrator.engageEmergencyReadOnly('suspicious oracle', 'operator@test');

    const after = processOn(scope, { lending: watch, executor: 'live' }); // restart
    expect((await after.orchestrator.controlState()).mode).toBe('read_only');
    const report = await after.orchestrator.runCycle('after-restart');
    expect(report.status).not.toBe('executed');
    expect(after.spies.broadcasts).toBe(0);
    expect(after.spies.execute).toBe(0);
  });

  it('2. a restart after the executor was called (result unknown) refuses to re-run and freezes automation', async () => {
    const scope = newScope();
    const crashed = new PgIdempotencyStore(handle.db, scope, { now: () => NOW });
    await crashed.begin('half-done', NOW, 300);
    await crashed.markExecutionStarted('half-done', 'repay:abc'); // then the process died

    const restarted = processOn(scope, { lending: watch, executor: 'live' });
    const same = await restarted.orchestrator.runCycle('half-done');
    expect(same.status).toBe('execution_in_doubt');
    const other = await restarted.orchestrator.runCycle('next-cycle');
    expect(other.status).not.toBe('executed');
    expect(restarted.spies.broadcasts).toBe(0);
    expect((await restarted.orchestrator.controlState()).mode).toBe('read_only');
    // ...and it stays frozen for the next restart too
    expect((await processOn(scope).orchestrator.controlState()).mode).toBe('read_only');
  });

  it('3. the same cycle key after a restart replays the stored outcome; nothing is sent twice', async () => {
    const scope = newScope();
    const first = processOn(scope, { lending: watch, executor: 'live' });
    expect((await first.orchestrator.runCycle('cycle-A')).status).toBe('executed');
    const restarted = processOn(scope, { lending: watch, executor: 'live' });
    const again = await restarted.orchestrator.runCycle('cycle-A');
    expect(again.status).toBe('duplicate_cycle');
    expect(first.spies.broadcasts + restarted.spies.broadcasts).toBe(1);
  });

  it('4. two processes, one key, at the same time: exactly one claims it and exactly one action is sent', async () => {
    const scope = newScope();
    const a = processOn(scope, { lending: watch, executor: 'live' });
    const b = processOn(scope, { lending: watch, executor: 'live' });
    const [ra, rb] = await Promise.all([
      a.orchestrator.runCycle('shared'),
      b.orchestrator.runCycle('shared'),
    ]);
    expect([ra.status, rb.status].filter((s) => s === 'executed')).toHaveLength(1);
    expect(a.spies.broadcasts + b.spies.broadcasts).toBe(1);

    // The raw claim, 10 contenders: one winner.
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        new PgIdempotencyStore(handle.db, scope, { now: () => NOW }).begin('race', NOW, 300),
      ),
    );
    expect(claims.filter((c) => c.claimed)).toHaveLength(1);
  });

  it('4b. a silent cycle is taken over by exactly one of several racing processes', async () => {
    const scope = newScope();
    const store = (now: Date) => new PgIdempotencyStore(handle.db, scope, { now: () => now });
    await store(NOW).begin('silent', NOW, 300);
    const later = new Date(NOW.getTime() + 600_000);
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => store(later).begin('silent', later, 300)),
    );
    expect(claims.filter((c) => c.claimed && c.tookOver)).toHaveLength(1);
  });

  it('5. a loosening based on a stale read is refused; concurrent tightenings keep the stricter mode', async () => {
    const scope = newScope();
    const clock = { now: () => NOW };
    const b = new ModeController(new PgControlStore(handle.db, scope, CHAIN, clock), clock);
    await b.engageReadOnly('incident', 'operator-b');
    const stale = new PgControlStore(handle.db, scope, CHAIN, clock);
    await stale.load();
    await b.setMode('normal', 'resolved', 'operator-b'); // version moves on
    await b.engageReadOnly('second incident', 'operator-b');
    await expect(stale.save({ ...(await b.current()), mode: 'normal' })).rejects.toBeInstanceOf(
      ControlConflictError,
    );
    expect((await new PgControlStore(handle.db, scope, CHAIN, clock).load()).mode).toBe(
      'read_only',
    );

    // Two tightenings on stale reads both go through; the stricter one wins.
    const t1 = new PgControlStore(handle.db, scope, CHAIN, clock);
    const t2 = new PgControlStore(handle.db, scope, CHAIN, clock);
    await b.setMode('normal', 'all clear', 'operator-b');
    const s1 = await t1.load();
    const s2 = await t2.load();
    await t1.save({ ...s1, mode: 'read_only', reason: 'audit failure' });
    await t2.save({
      ...s2,
      mode: 'risk_reduction_only',
      reason: 'failures',
      consecutiveFailures: 3,
    });
    const final = await new PgControlStore(handle.db, scope, CHAIN, clock).load();
    expect(final.mode).toBe('read_only');
    expect(final.consecutiveFailures).toBe(3);
  });

  it('7. database unreachable: the mode reads as read-only and a cycle executes nothing', async () => {
    const dead = createDatabase('postgres://nobody:nothing@127.0.0.1:1/none', { max: 1 });
    try {
      const w = makeWorld({
        lending: watch,
        executor: 'live',
        stores: (clock) => ({
          control: new PgControlStore(dead.db, 'dead:scope', CHAIN, clock),
          idempotency: new PgIdempotencyStore(dead.db, 'dead:scope', clock),
        }),
      });
      expect((await w.orchestrator.controlState()).mode).toBe('read_only');
      const r = await w.orchestrator.runCycle('no-db');
      expect(r.status).not.toBe('executed');
      expect(w.spies.execute).toBe(0);
      expect(w.spies.broadcasts).toBe(0);
    } finally {
      await dead.close();
    }
  });

  it('8. every control change is in the append-only history and on the audit chain, which verifies', async () => {
    const scope = newScope();
    const w = processOn(scope);
    await w.orchestrator.engageEmergencyReadOnly('drill', 'operator@test');
    await w.orchestrator.setMode('normal', 'drill over', 'operator@test');
    const history = await new PgControlStore(handle.db, scope, CHAIN, { now: () => NOW }).history();
    expect(history.map((h) => h.mode)).toEqual(['normal', 'read_only', 'normal']); // newest first, incl. initial
    expect(history.every((h) => h.auditChain === CHAIN && (h.auditSeq ?? 0) > 0)).toBe(true);
    const [row] = await handle.db
      .select()
      .from(orchestratorControl)
      .where(sql`${orchestratorControl.scope} = ${scope}`);
    expect(row?.auditSeq).toBe(history[0]?.auditSeq);
    const chain = await new EvidenceStore(handle.db).verify(CHAIN);
    expect(chain.ok).toBe(true);
    await expect(
      handle.db.update(orchestratorControlHistory).set({ reason: 'rewritten' }),
    ).rejects.toThrow(/append-only/);
  });
});
