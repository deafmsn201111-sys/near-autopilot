import { randomBytes } from 'node:crypto';
import { createDatabase, runMigrations, sql, type DatabaseHandle } from '@near-autopilot/db';
import { accountId } from '@near-autopilot/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Analysis } from '../src/analytics/ai-analysis';
import { DrizzleAnalysisStore } from '../src/analytics/analysis-store';

/** The saved-analysis store on a real PostgreSQL (skipped unless DATABASE_TEST_URL is set; CI sets it). */
const adminUrl = process.env['DATABASE_TEST_URL'];
const NOW = new Date('2026-11-14T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ALICE = accountId('alice.near');

const analysis = (note: string): Analysis => ({
  source: 'llm',
  fallback: null,
  note,
  recommendations: [],
  calledTools: [],
  trace: [],
  run: null,
  read: null,
  cachedAt: null,
});

describe.skipIf(!adminUrl)('DrizzleAnalysisStore (PostgreSQL)', () => {
  const dbName = `autopilot_analyses_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;
  let store: DrizzleAnalysisStore;

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 2 });
    await runMigrations(handle.db);
    store = new DrizzleAnalysisStore(handle.db, () => NOW);
  });

  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  it('keeps only the last analysis per account and strategy', async () => {
    expect(await store.latest(ALICE, 'balanced')).toBeNull();
    await store.save(ALICE, 'balanced', {
      key: 'k1',
      signature: 's1',
      at: NOW,
      analysis: analysis('one'),
    });
    await store.save(ALICE, 'balanced', {
      key: 'k2',
      signature: null,
      at: NOW,
      analysis: analysis('two'),
    });
    await store.save(ALICE, 'aggressive', {
      key: 'k3',
      signature: 's3',
      at: NOW,
      analysis: analysis('three'),
    });
    expect(await store.latest(ALICE, 'balanced')).toEqual({
      key: 'k2',
      signature: null,
      at: NOW,
      analysis: analysis('two'),
    });
    expect((await store.latest(ALICE, 'aggressive'))?.analysis.note).toBe('three');
  });

  it('purges analyses older than 30 days', async () => {
    await store.save(ALICE, 'conservative', {
      key: 'old',
      signature: null,
      at: new Date(NOW.getTime() - 31 * DAY),
      analysis: analysis('old'),
    });
    await store.purge();
    expect(await store.latest(ALICE, 'conservative')).toBeNull();
    expect(await store.latest(ALICE, 'aggressive')).not.toBeNull();
  });
});
