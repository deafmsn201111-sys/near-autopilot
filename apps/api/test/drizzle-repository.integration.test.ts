import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  createDatabase,
  getTableColumns,
  getTableName,
  proposals,
  runMigrations,
  runs,
  sql,
  type DatabaseHandle,
  type Table,
} from '@near-autopilot/db';
import { DrizzleRepository } from '../src/infra/drizzle-repository';
import type { ProposalRecord } from '../src/repository';

/**
 * Real-Postgres tests for the migrations and DrizzleRepository. Skipped unless DATABASE_TEST_URL is set:
 *   DATABASE_TEST_URL=postgres://user:pass@127.0.0.1:5432/postgres pnpm --filter @near-autopilot/api test:db
 * The URL only needs CREATEDB rights. Each run creates its OWN throwaway database (autopilot_it_<random>), migrates
 * it, and drops only that database afterwards; nothing else on the server is read or modified.
 */
const adminUrl = process.env['DATABASE_TEST_URL'];

describe.skipIf(!adminUrl)('DrizzleRepository on PostgreSQL', () => {
  const dbName = `autopilot_it_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 4 });
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  it('migrations are idempotent', async () => {
    await runMigrations(handle.db);
    const applied = await handle.db.execute<{ n: number }>(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(applied.rows[0]?.n).toBe(3);
  });

  it('the migrated tables have exactly the columns the Drizzle schema declares', async () => {
    const tables: readonly Table[] = [runs, proposals, auditEvents];
    for (const table of tables) {
      const declared = Object.values(getTableColumns(table))
        .map((c) => `${c.name}:${c.notNull ? 'NO' : 'YES'}`)
        .sort();
      const actual = await handle.db.execute<{ column_name: string; is_nullable: string }>(
        sql`select column_name, is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = ${getTableName(table)}`,
      );
      expect(actual.rows.map((r) => `${r.column_name}:${r.is_nullable}`).sort()).toEqual(declared);
    }
  });

  const proposal = (over: Partial<ProposalRecord> & Pick<ProposalRecord, 'id' | 'runId'>) => {
    const at = new Date('2026-11-04T10:00:00Z');
    return {
      accountId: 'demo.testnet',
      agentId: 'guardian',
      kind: 'lending.repay',
      summary: 'Repay 40 USDt',
      reason: 'HF below trigger',
      intent: { kind: 'lending.repay', amount: '40000000' },
      valueUsdMicro: 39_700_001n,
      status: 'dry_run',
      violations: [{ rule: 'max_action_value', message: 'too big', severity: 'reject' }],
      planHash: null,
      executionMode: 'dry-run',
      txHash: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      ...over,
    } satisfies ProposalRecord;
  };

  it('round-trips runs and proposals with their provenance, bigint values and violations', async () => {
    const repo = new DrizzleRepository(handle.db, { dataSource: 'simulation', network: 'testnet' });
    const startedAt = new Date('2026-11-04T10:00:00Z');
    await repo.createRun({ id: 'run-sim', accountId: 'demo.testnet', startedAt });
    await repo.insertProposal(proposal({ id: 'p-sim', runId: 'run-sim' }));
    await repo.finishRun('run-sim', {
      status: 'completed',
      finishedAt: new Date('2026-11-04T10:00:01Z'),
      error: null,
      outcome: 'no action: DATA_NOT_FRESH',
      snapshot: { engine: 'orchestrator' },
    });
    await repo.updateProposal('p-sim', {
      error: 'note',
      violations: [],
      updatedAt: new Date('2026-11-04T10:00:02Z'),
    });

    const [run] = (await repo.listRuns(10)).filter((r) => r.id === 'run-sim');
    expect(run).toMatchObject({
      status: 'completed',
      dataSource: 'simulation',
      network: 'testnet',
      proposalCount: 1,
      startedAt,
      outcome: 'no action: DATA_NOT_FRESH',
    });
    const [p] = await repo.listProposals({ limit: 10, runId: 'run-sim' });
    expect(p).toMatchObject({
      id: 'p-sim',
      dataSource: 'simulation',
      network: 'testnet',
      status: 'dry_run',
      executionMode: 'dry-run',
      txHash: null,
      error: 'note',
      intent: { kind: 'lending.repay', amount: '40000000' },
    });
    expect(p?.violations).toEqual([]);
    expect(p?.valueUsdMicro).toBe(39_700_001n);
  });

  it('isolates deployments sharing a database: simulation and testnet never see each other', async () => {
    const chain = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'testnet' });
    const sim = new DrizzleRepository(handle.db, { dataSource: 'simulation', network: 'testnet' });
    await chain.createRun({ id: 'run-chain', accountId: 'demo.testnet', startedAt: new Date() });
    await chain.insertProposal(proposal({ id: 'p-chain', runId: 'run-chain' }));

    const [p] = await chain.listProposals({ limit: 10, runId: 'run-chain' });
    expect(p).toMatchObject({ dataSource: 'chain', network: 'testnet' });
    expect(await chain.listProposals({ limit: 10, runId: 'run-sim' })).toEqual([]);
    expect((await chain.listRuns(50)).map((r) => r.id)).toEqual(['run-chain']);
    expect((await chain.listProposals({ limit: 50 })).map((r) => r.id)).toEqual(['p-chain']);

    expect((await sim.listRuns(50)).map((r) => r.id)).toEqual(['run-sim']);
    expect((await sim.listProposals({ limit: 50 })).map((r) => r.id)).toEqual(['p-sim']);
    expect(await sim.listProposals({ limit: 10, runId: 'run-chain' })).toEqual([]);
  });

  it('reads rows written before migration 0001 (no network) as chain/mainnet', async () => {
    await handle.db.execute(
      sql`insert into runs (id, account_id, status, started_at) values ('run-old', 'old.near', 'completed', now())`,
    );
    const mainnet = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'mainnet' });
    const [old] = (await mainnet.listRuns(50)).filter((r) => r.id === 'run-old');
    expect(old).toMatchObject({ dataSource: 'chain', network: 'mainnet', proposalCount: 0 });
    const testnet = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'testnet' });
    expect((await testnet.listRuns(50)).map((r) => r.id)).not.toContain('run-old');
  });

  it('execution stats count only live rows that may have reached the chain', async () => {
    const repo = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'testnet' });
    const account = 'stats.testnet';
    const t = (s: string) => new Date(`2026-11-04T${s}Z`);
    await repo.createRun({ id: 'run-stats', accountId: account, startedAt: t('09:00:00') });
    const row = (id: string, over: Partial<ProposalRecord>) =>
      repo.insertProposal(
        proposal({
          id,
          runId: 'run-stats',
          accountId: account,
          valueUsdMicro: 1_000_000n,
          ...over,
        }),
      );
    await row('executed', { status: 'executed', executionMode: 'live', updatedAt: t('10:00:00') });
    await row('approved', { status: 'approved', executionMode: 'live', updatedAt: t('10:01:00') });
    await row('unknown', {
      status: 'failed',
      executionMode: 'live',
      txHash: 'hash-1',
      updatedAt: t('10:02:00'),
    });
    // Not counted: failed before signing, dry-run, rejected, too old, another account.
    await row('failed-unsigned', {
      status: 'failed',
      executionMode: 'live',
      updatedAt: t('10:03:00'),
    });
    await row('dry', { status: 'dry_run', executionMode: 'dry-run', updatedAt: t('10:04:00') });
    await row('rejected', { status: 'rejected', executionMode: null, updatedAt: t('10:05:00') });
    await row('old', { status: 'executed', executionMode: 'live', updatedAt: t('01:00:00') });
    await row('other', {
      status: 'executed',
      executionMode: 'live',
      accountId: 'other.testnet',
      updatedAt: t('10:06:00'),
    });

    const stats = await repo.getExecutionStats(account, t('09:00:00'));
    expect(stats.spentLast24hUsdMicro).toBe(3_000_000n);
    expect(stats.lastExecutedAt?.toISOString()).toBe('2026-11-04T10:02:00.000Z');
  });

  it('appends audit events and answers ping', async () => {
    const repo = new DrizzleRepository(handle.db, { dataSource: 'simulation', network: 'testnet' });
    await repo.appendAudit({
      at: new Date(),
      type: 'escalation_warn',
      runId: 'run-sim',
      proposalId: null,
      payload: { code: 'GUARDIAN_BLIND' },
    });
    const rows = await handle.db.execute<{ type: string }>(
      sql`select type from audit_events where run_id = 'run-sim'`,
    );
    expect(rows.rows.map((r) => r.type)).toEqual(['escalation_warn']);
    await expect(repo.ping()).resolves.toBeUndefined();
  });
});
