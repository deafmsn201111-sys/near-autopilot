import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditEvents,
  createDatabase,
  getTableColumns,
  getTableName,
  marketPrices,
  proposals,
  runMigrations,
  runs,
  sql,
  testnetTransactions,
  type DatabaseHandle,
  type Table,
} from '@near-autopilot/db';
import { accountId } from '@near-autopilot/core';
import { DrizzleRepository } from '../src/infra/drizzle-repository';
import { REFERENCE_ASSETS } from '../src/market-data/assets';
import { parseDecimal } from '../src/market-data/decimal';
import { REFERENCE_LABEL } from '../src/market-data/model';
import { DrizzleMarketPriceStore } from '../src/market-data/store';
import { DrizzleTestnetTxLedger } from '../src/testnet-tx/ledger';
import type { TestnetTxRecord } from '../src/testnet-tx/model';
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
    expect(applied.rows[0]?.n).toBe(5);
  });

  it('the migrated tables have exactly the columns the Drizzle schema declares', async () => {
    const tables: readonly Table[] = [
      runs,
      proposals,
      auditEvents,
      testnetTransactions,
      marketPrices,
    ];
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

  it('testnet transaction ledger: u128 amounts round-trip, status changes are compare-and-set', async () => {
    const ledger = new DrizzleTestnetTxLedger(handle.db);
    const at = new Date('2026-11-04T12:00:00Z');
    const record: TestnetTxRecord = {
      id: 'tx-1',
      previewHash: 'p'.repeat(64),
      network: 'testnet',
      signerId: accountId('sergetest.testnet'),
      operation: 'wrap.storage_deposit',
      receiverId: accountId('wrap.testnet'),
      methodName: 'storage_deposit',
      preview: {
        network: 'testnet',
        chainId: 'testnet',
        blockHeight: 1,
        operation: 'wrap.storage_deposit',
        signerId: 'sergetest.testnet',
        receiverId: 'wrap.testnet',
        methodName: 'storage_deposit',
        args: { account_id: 'sergetest.testnet', registration_only: true },
        depositYocto: '1250000000000000000000',
        gas: '30000000000000',
        gasPriceYocto: '100000000',
        maxFeeYocto: '4200000000000000000000',
        maxCostYocto: '5450000000000000000000',
        availableBeforeYocto: '14998380000000000000000000',
        budget: { spentYocto: '0', remainingAfterYocto: '994550000000000000000000' },
        expectedResult: 'registered',
        risks: [],
      },
      status: 'prepared',
      depositYocto: 1_250_000_000_000_000_000_000n,
      maxCostYocto: 5_450_000_000_000_000_000_000n,
      actualCostYocto: null,
      txHash: null,
      error: null,
      createdAt: at,
      expiresAt: new Date(at.getTime() + 600_000),
      updatedAt: at,
    };
    await ledger.insert(record);
    await expect(ledger.insert({ ...record, id: 'tx-dup' })).rejects.toThrow();
    expect(await ledger.byPreviewHash(record.previewHash)).toEqual(record);

    expect(await ledger.transition('tx-1', 'prepared', { status: 'approved', updatedAt: at })).toBe(
      true,
    );
    // A second claim of the same preview loses.
    expect(await ledger.transition('tx-1', 'prepared', { status: 'approved', updatedAt: at })).toBe(
      false,
    );
    expect(
      await ledger.transition('tx-1', 'approved', {
        status: 'submitted',
        txHash: 'HASH1',
        updatedAt: at,
      }),
    ).toBe(true);
    const big = 340_282_366_920_938_463_463_374_607_431_768_211_455n; // u128::MAX
    await ledger.transition('tx-1', 'submitted', {
      status: 'confirmed',
      actualCostYocto: big,
      updatedAt: at,
    });
    expect(await ledger.byTxHash('HASH1')).toMatchObject({
      status: 'confirmed',
      actualCostYocto: big,
    });
    await expect(
      handle.db.execute(sql`update testnet_transactions set network = 'mainnet' where id = 'tx-1'`),
    ).rejects.toThrow();
  });

  it('market prices: every report persists source, networks, timestamp and status; mainnet->testnet only', async () => {
    const store = new DrizzleMarketPriceStore(handle.db);
    expect(await store.latest()).toEqual([]);
    const at = new Date('2026-11-04T12:00:00Z');
    const a = REFERENCE_ASSETS[0];
    if (!a) throw new Error('no asset');
    const observation = {
      source: 'defillama' as const,
      network: 'mainnet' as const,
      assetId: 'coingecko:near',
      contract: null,
      priceUsd: parseDecimal('3.986570184437296'),
      quoteCurrency: 'USD' as const,
      confidence: '0.99',
      publishedAt: new Date(at.getTime() - 20_000),
      fetchedAt: at,
      ageMs: 20_000,
      status: 'valid' as const,
      reason: null,
    };
    for (const id of ['r1', 'r2']) {
      await store.record({
        id,
        fetchedAt: id === 'r1' ? at : new Date(at.getTime() + 60_000),
        marketNetwork: 'mainnet',
        executionNetwork: 'testnet',
        sources: [{ source: 'pyth', health: 'unavailable', detail: 'PYTH_API_KEY is not set' }],
        range24hBps: new Map(),
        assets: [
          {
            testnetToken: a.testnetToken,
            referenceSymbol: a.reference.symbol,
            mainnetContract: a.reference.mainnetContract,
            status: 'single_source',
            priceUsd: observation.priceUsd,
            chosen: observation,
            crossCheck: null,
            spreadBps: null,
            observations: [observation],
            reason: 'only defillama returned a valid price',
            label: REFERENCE_LABEL,
          },
        ],
      });
    }
    const latest = await store.latest();
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({
      reportId: 'r2',
      testnetToken: 'wrap.testnet',
      status: 'single_source',
      priceUsd: '3.986570184437296',
      source: 'defillama',
      sourceAssetId: 'coingecko:near',
      marketNetwork: 'mainnet',
      executionNetwork: 'testnet',
      ageMs: 20_000,
    });
    expect(JSON.stringify(latest[0]?.observations)).toContain('"status":"valid"');
    await expect(
      handle.db.execute(sql`update market_prices set execution_network = 'mainnet'`),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`update market_prices set market_network = 'testnet'`),
    ).rejects.toThrow();
  });
});
