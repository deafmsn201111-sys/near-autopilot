import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, sql, type DatabaseHandle } from '@near-autopilot/db';
import {
  checkpointAll,
  generateCheckpointKey,
  verifyCheckpoints,
} from '../src/evidence/checkpoint';
import { DrizzleRepository } from '../src/infra/drizzle-repository';

/**
 * Signed checkpoints catch what the hash chain alone cannot: a rewrite of the whole chain with recomputed hashes, and a
 * cut of its tail. Real PostgreSQL (skipped unless DATABASE_TEST_URL is set).
 */
const adminUrl = process.env['DATABASE_TEST_URL'];

describe.skipIf(!adminUrl)('signed audit checkpoints (PostgreSQL)', () => {
  const dbName = `autopilot_ckpt_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;
  const key = generateCheckpointKey();
  const file = join(mkdtempSync(join(tmpdir(), 'ckpt-')), 'checkpoints.jsonl');
  const append = async (n: number) => {
    const repo = new DrizzleRepository(handle.db, { dataSource: 'simulation', network: 'testnet' });
    for (let i = 0; i < n; i += 1)
      await repo.appendAudit({
        at: new Date(),
        type: 'test.event',
        runId: null,
        proposalId: null,
        payload: { i },
      });
  };
  const unguarded = async (q: ReturnType<typeof sql>) => {
    await handle.db.execute(sql`alter table audit_events disable trigger audit_events_append_only`);
    try {
      await handle.db.execute(q);
    } finally {
      await handle.db.execute(
        sql`alter table audit_events enable trigger audit_events_append_only`,
      );
    }
  };

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 4 });
    await runMigrations(handle.db);
    await append(5);
  });
  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  it('signs each chain head once, to the table and the file, and verifies with the public key only', async () => {
    const made = await checkpointAll(handle.db, key.privateHex, { file });
    expect(made.map((c) => [c.chain, c.seq])).toEqual([['simulation:testnet', 5]]);
    expect(await checkpointAll(handle.db, key.privateHex, { file })).toEqual([]); // head did not move
    await append(2);
    expect((await checkpointAll(handle.db, key.privateHex, { file })).map((c) => c.seq)).toEqual([
      7,
    ]);
    const [check] = await verifyCheckpoints(handle.db, key.publicHex, { file });
    expect(check).toMatchObject({ chain: 'simulation:testnet', checkpoints: 2, ok: true });
  });

  it('a different key does not verify (a key swapped in the database is useless)', async () => {
    const other = generateCheckpointKey();
    const [check] = await verifyCheckpoints(handle.db, other.publicHex, { file });
    expect(check?.ok).toBe(false);
    expect(check?.problems[0]).toMatch(/signature invalid/);
  });

  it('a rewritten entry is caught even if the hash chain was recomputed around it', async () => {
    await unguarded(
      sql`update audit_events set hash = ${'f'.repeat(64)} where chain = 'simulation:testnet' and seq = 5`,
    );
    const [check] = await verifyCheckpoints(handle.db, key.publicHex, { file });
    expect(check?.ok).toBe(false);
    expect(check?.problems.join(' ')).toMatch(/entry 5 no longer has the checkpointed hash/);
  });

  it('a cut tail is caught, and so is a checkpoint deleted from the table (the file still has it)', async () => {
    await unguarded(sql`delete from audit_events where chain = 'simulation:testnet' and seq >= 6`);
    await handle.db.execute(
      sql`alter table audit_checkpoints disable trigger audit_checkpoints_append_only`,
    );
    await handle.db.execute(sql`delete from audit_checkpoints where seq = 7`);
    await handle.db.execute(
      sql`alter table audit_checkpoints enable trigger audit_checkpoints_append_only`,
    );
    const [check] = await verifyCheckpoints(handle.db, key.publicHex, { file });
    expect(check?.problems.join(' ')).toMatch(
      /the chain ends at seq 5, but seq 7 was checkpointed/,
    );
  });
});
