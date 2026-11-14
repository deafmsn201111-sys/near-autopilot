import { randomBytes } from 'node:crypto';
import {
  createDatabase,
  events,
  runMigrations,
  sql,
  type DatabaseHandle,
} from '@near-autopilot/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleEventStore } from '../src/analytics/events-store';

/** The events store on a real PostgreSQL (skipped unless DATABASE_TEST_URL is set; CI sets it). */
const adminUrl = process.env['DATABASE_TEST_URL'];
const NOW = new Date('2026-11-14T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const HASH = '4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR';

describe.skipIf(!adminUrl)('DrizzleEventStore (PostgreSQL)', () => {
  const dbName = `autopilot_events_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;
  let store: DrizzleEventStore;

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 2 });
    await runMigrations(handle.db);
    store = new DrizzleEventStore(handle.db, () => NOW);
  });

  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  beforeEach(async () => {
    await handle.db.delete(events);
  });

  it('stores a blocked prepare with its failed checks, and has no IP column', async () => {
    const checks = [
      { rule: 'methods', pass: false, messages: ['x#delete_account: not allowlisted'] },
    ];
    await store.add({
      at: NOW,
      kind: 'prepare_blocked',
      accountId: 'alice.near',
      source: 'server',
      cascadeId: 'c1',
      intent: { action: 'supply' },
      verdict: 'BLOCK',
      checks,
    });
    const [row] = await handle.db.select().from(events);
    expect(row).toMatchObject({ kind: 'prepare_blocked', verdict: 'BLOCK', checks });
    expect(Object.keys(row ?? {}).some((k) => /ip|visitor|address/i.test(k))).toBe(false);
    expect((await store.verdicts(10)).map((v) => v.cascadeId)).toEqual(['c1']);
  });

  it('stores a tx hash once', async () => {
    const signed = {
      at: NOW,
      kind: 'signed' as const,
      accountId: 'alice.near',
      source: 'rpc' as const,
      cascadeId: 'c1',
      txHash: HASH,
    };
    expect(await store.add(signed)).toBe(true);
    expect(await store.add(signed)).toBe(false);
    expect(await store.byCascade('c1')).toHaveLength(1);
  });

  it('answers whether an account connected since a time', async () => {
    await store.add({ at: NOW, kind: 'connect', accountId: 'alice.near', source: 'client' });
    expect(await store.hasSince('alice.near', 'connect', new Date(NOW.getTime() - 1))).toBe(true);
    expect(await store.hasSince('alice.near', 'connect', new Date(NOW.getTime() + 1))).toBe(false);
    expect(await store.hasSince('bob.near', 'connect', new Date(0))).toBe(false);
  });

  it('lists an account newest first', async () => {
    await store.add({
      at: new Date(NOW.getTime() - 1000),
      kind: 'analyse',
      accountId: 'a.near',
      source: 'server',
    });
    await store.add({ at: NOW, kind: 'connect', accountId: 'a.near', source: 'client' });
    await store.add({ at: NOW, kind: 'connect', accountId: 'b.near', source: 'client' });
    expect((await store.forAccount('a.near', 10)).map((e) => e.kind)).toEqual([
      'connect',
      'analyse',
    ]);
  });

  it('purges rows older than 30 days only', async () => {
    for (const [id, at] of [
      ['old', NOW.getTime() - 30 * DAY - 1],
      ['edge', NOW.getTime() - 30 * DAY],
      ['new', NOW.getTime()],
    ] as const)
      await store.add({
        at: new Date(at),
        kind: 'connect',
        accountId: `${id}.near`,
        source: 'client',
      });
    await store.purge();
    const left = (await handle.db.select({ a: events.accountId }).from(events)).map((r) => r.a);
    expect(left.sort()).toEqual(['edge.near', 'new.near']);
  });
});
