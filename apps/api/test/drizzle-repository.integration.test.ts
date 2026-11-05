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
  yieldObservations,
  collectorCycles,
  marketSnapshots,
  priceObservations,
  rheaPools,
  rheaPoolObservations,
  burrowMarkets,
  burrowMarketObservations,
  executionRoutes,
  policyVerdicts,
  portfolioAnalyses,
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
import type { YieldEstimate } from '../src/yield/model';
import { DrizzleYieldStore } from '../src/yield/store';
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
    expect(applied.rows[0]?.n).toBe(11);
  });

  it('the migrated tables have exactly the columns the Drizzle schema declares', async () => {
    const tables: readonly Table[] = [
      runs,
      proposals,
      auditEvents,
      testnetTransactions,
      marketPrices,
      yieldObservations,
      collectorCycles,
      marketSnapshots,
      priceObservations,
      rheaPools,
      rheaPoolObservations,
      burrowMarkets,
      burrowMarketObservations,
      portfolioAnalyses,
      policyVerdicts,
      executionRoutes,
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
    // `none`: the shadow analysis, where nothing is executed anywhere.
    await handle.db.execute(
      sql`update market_prices set execution_network = 'none' where report_id = 'r1'`,
    );
    await expect(
      handle.db.execute(sql`update market_prices set market_network = 'testnet'`),
    ).rejects.toThrow();
  });

  it('yield observations: valid and rejected estimates persist with block, reasons and raw data; testnet only', async () => {
    const store = new DrizzleYieldStore(handle.db);
    expect(await store.latest()).toEqual([]);
    const t0 = new Date('2026-11-05T09:00:00Z');
    const estimate = (at: Date, height: number, volumesIn: string[]): YieldEstimate => ({
      source: 'rhea_v1',
      network: 'testnet',
      contract: 'ref-finance-101.testnet',
      methods: ['get_pool', 'get_pool_volumes', 'metadata'],
      marketId: 'pool:34',
      assetIds: ['wrap.testnet', 'usdt.fakes.testnet'],
      yieldType: 'lp_fee',
      apr: null,
      apy: null,
      calculationMethod: 'calculated',
      formula: 'f',
      observationPeriodSeconds: null,
      utilization: null,
      liquidityUsd: parseDecimal('12.5'),
      volumeUsd: null,
      priceStatus: 'fresh',
      block: { height, timestamp: at },
      sourceTimestamp: null,
      validationStatus: 'rejected',
      reasons: [{ code: 'UNVERIFIED_POOL', detail: 'observed only' }],
      raw: { volumesIn },
    });
    for (const [id, offset, height] of [
      ['y1', 0, 100],
      ['y2', 7_200_000, 200],
    ] as const) {
      const at = new Date(t0.getTime() + offset);
      await store.record({
        id,
        origin: 'scheduled',
        network: 'testnet',
        observedAt: at,
        block: { height, timestamp: at },
        sources: [
          {
            source: 'rhea_v1',
            contract: 'ref-finance-101.testnet',
            health: 'ok',
            detail: null,
            marketsRead: 1,
          },
        ],
        estimates: [estimate(at, height, [String(height), '0'])],
      });
    }
    const latest = await store.latest();
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({
      reportId: 'y2',
      blockHeight: 200,
      source: 'rhea_v1',
      marketId: 'pool:34',
      validationStatus: 'rejected',
      liquidityUsd: '12.5',
      network: 'testnet',
    });
    // The start of an observation period: the latest observation at least 1 h before the given time.
    const prev = await store.previous(
      'rhea_v1',
      'pool:34',
      new Date(t0.getTime() + 7_200_000),
      3_600,
    );
    expect(prev?.blockHeight).toBe(100);
    expect(prev?.raw).toEqual({ volumesIn: ['100', '0'] });
    expect(prev?.reasonCodes).toEqual(['UNVERIFIED_POOL']);
    expect(await store.previous('rhea_v1', 'pool:34', t0, 3_600)).toBeNull();
    // Data may be READ from testnet or mainnet (shadow analysis); any other value is refused.
    await expect(
      handle.db.execute(sql`update yield_observations set network = 'devnet'`),
    ).rejects.toThrow();
    await handle.db.execute(
      sql`update yield_observations set network = 'mainnet' where report_id = 'y1'`,
    );
    // A borrow rate can never be stored as a usable yield.
    await expect(
      handle.db.execute(
        sql`update yield_observations set yield_type = 'lending_borrow', validation_status = 'valid'`,
      ),
    ).rejects.toThrow();
  });

  it('policy verdicts round-trip per deployment; verdict and outcome must agree', async () => {
    const shadow = new DrizzleRepository(handle.db, {
      dataSource: 'simulation',
      network: 'mainnet',
    });
    const chain = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'testnet' });
    const v = {
      id: 'pv-1',
      evaluatedAt: new Date('2026-11-05T10:00:00Z'),
      engine: 'orchestrator' as const,
      runId: 'cycle-1',
      intentId: 'i-1',
      intentKind: 'lending.repay',
      verdict: 'BLOCK' as const,
      outcome: 'reject' as const,
      policyVersion: 'rules-2026.11.1+cfg:0123456789abcdef',
      snapshotId: `sha256:${'c'.repeat(64)}`,
      planHash: 'd'.repeat(64),
      valueUsdMicro: 123_456_789_012n,
      checks: [{ rule: 'kill_switch', result: 'BLOCK' as const, messages: ['off'] }],
      violations: [{ rule: 'kill_switch', message: 'off', severity: 'reject' as const }],
      input: { snapshot: { nativeBalance: '15000000000000000000000000' } },
    };
    await shadow.insertPolicyVerdict(v);
    const [row] = await shadow.listPolicyVerdicts({ limit: 5 });
    expect(row).toMatchObject({ ...v, dataSource: 'simulation', network: 'mainnet' });
    expect(await chain.listPolicyVerdicts({ limit: 5 })).toEqual([]);
    expect(await shadow.listPolicyVerdicts({ limit: 5, verdict: 'ALLOW' })).toEqual([]);
    // The table refuses a verdict that contradicts its outcome.
    await expect(
      shadow.insertPolicyVerdict({ ...v, id: 'pv-2', verdict: 'ALLOW' }),
    ).rejects.toThrow();
  });

  it('execution routes round-trip per deployment; a routed row names its venue, others do not', async () => {
    const shadow = new DrizzleRepository(handle.db, {
      dataSource: 'simulation',
      network: 'mainnet',
    });
    const chain = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'testnet' });
    const r = {
      id: 'route-1',
      createdAt: new Date('2026-11-05T19:00:00Z'),
      origin: 'probe' as const,
      outcome: 'routed' as const,
      decisionId: null,
      intentId: null,
      planHash: null,
      tokenIn: 'wrap.near',
      tokenOut: 'usdc.near',
      amountIn: 2_739_726_027_397_260_273_972_603n,
      chosenVenue: 'rhea',
      advantageBps: 12,
      reason: 'rhea nets 12 bps more',
      quotes: { gasPriceYocto: '100000000', scored: [] },
    };
    await shadow.insertExecutionRoute(r);
    expect(await shadow.listExecutionRoutes({ limit: 5 })).toEqual([
      { ...r, dataSource: 'simulation', network: 'mainnet' },
    ]);
    expect(await shadow.listExecutionRoutes({ limit: 5, origin: 'gateway' })).toEqual([]);
    expect(await chain.listExecutionRoutes({ limit: 5 })).toEqual([]);
    await expect(
      shadow.insertExecutionRoute({ ...r, id: 'route-2', chosenVenue: null }),
    ).rejects.toThrow();
    await expect(
      shadow.insertExecutionRoute({ ...r, id: 'route-3', outcome: 'refused' }),
    ).rejects.toThrow();
    await expect(
      shadow.insertExecutionRoute({ ...r, id: 'route-4', chosenVenue: 'some-dex' }),
    ).rejects.toThrow();
  });

  it('findPolicyVerdict sees only its own deployment', async () => {
    const shadow = new DrizzleRepository(handle.db, {
      dataSource: 'simulation',
      network: 'mainnet',
    });
    const chain = new DrizzleRepository(handle.db, { dataSource: 'chain', network: 'testnet' });
    expect(await shadow.findPolicyVerdict('pv-1')).toEqual({
      verdict: 'BLOCK',
      planHash: 'd'.repeat(64),
    });
    expect(await chain.findPolicyVerdict('pv-1')).toBeNull();
    expect(await shadow.findPolicyVerdict('nope')).toBeNull();
  });

  it('price observations accept every provider of the NEAR quorum, and nothing else', async () => {
    const { CollectorStore } = await import('../src/collector/store');
    const store = new CollectorStore(handle.db);
    const base = {
      network: 'mainnet' as const,
      contract: null,
      priceUsd: { mantissa: 37065n, exponent: -4 },
      quoteCurrency: 'USD' as const,
      confidence: null,
      publishedAt: new Date(),
      fetchedAt: new Date(),
      ageMs: 1_000,
      status: 'valid' as const,
      reason: null,
      asset: 'wrap.near',
    };
    // Live regression: migration 0007's CHECK knew only pyth/defillama, so every cycle after the quorum failed.
    await store.insertPrices(
      'snap-quorum',
      (['pyth', 'defillama', 'coinbase', 'kraken', 'binance'] as const).map((source) => ({
        ...base,
        source,
        assetId: `${source}:NEAR`,
      })),
    );
    const n = await handle.db.execute<{ n: number }>(
      sql`select count(*)::int as n from price_observations where snapshot_id = 'snap-quorum'`,
    );
    expect(n.rows[0]?.n).toBe(5);
    await expect(
      handle.db.execute(
        sql`insert into price_observations (id, snapshot_id, asset, source, source_asset_id, quote_currency, observed_at, status)
            values ('x', 's', 'a', 'okx', 'k', 'USD', now(), 'valid')`,
      ),
    ).rejects.toThrow();
  });

  it('collector: one running cycle at a time; pool observations are unique per block; registry upserts', async () => {
    const { CollectorStore } = await import('../src/collector/store');
    const store = new CollectorStore(handle.db);
    const at = new Date('2026-11-05T10:00:00Z');
    expect(await store.startCycle('c1', 'scheduled', at, true)).toBe(true);
    // A second cycle cannot start while one is running, from any process.
    expect(await store.startCycle('c2', 'on_demand', at, false)).toBe(false);
    await store.finishCycle('c1', {
      status: 'success',
      finishedAt: at,
      durationMs: 1,
      records: 0,
      sources: [],
      error: null,
      snapshotId: null,
    });
    expect(await store.startCycle('c3', 'on_demand', at, false)).toBe(true);
    await store.closeAbandoned(at);
    expect((await store.recentCycles(5)).find((c) => c.id === 'c3')?.status).toBe('failed');
    const row = {
      snapshotId: 's',
      poolKey: 'v1:1',
      blockHeight: 10,
      blockTimestamp: at,
      reserves: ['1', '2'],
      volumesIn: ['0', '0'],
      feeBps: 30,
      adminFeeBps: 2000,
      tvlUsd: '100',
      priceQuality: 'OK',
      quality: 'OK',
      raw: {},
    };
    await store.insertPoolObservations([{ ...row, id: 'a' }]);
    await store.insertPoolObservations([{ ...row, id: 'b' }]); // same pool + block: ignored, not duplicated
    expect(await store.poolHistory('v1:1', new Date(0))).toHaveLength(1);
    // A registry-scan reading carries no cumulative volumes: it must never start a fee window or the history, even
    // when it is the oldest point (every pool's first reading comes from a registry scan).
    const scanAt = new Date(at.getTime() - 3_600_000);
    await store.insertPoolObservations([
      { ...row, id: 'scan', blockHeight: 5, blockTimestamp: scanAt, volumesIn: null },
    ]);
    const later = new Date(at.getTime() + 900_000);
    await store.insertPoolObservations([
      { ...row, id: 'c', blockHeight: 20, blockTimestamp: later, volumesIn: ['5', '5'] },
    ]);
    expect((await store.poolPointAtOrBefore('v1:1', null))?.blockHeight).toBe(10);
    expect((await store.poolPointAtOrBefore('v1:1', scanAt))?.blockHeight).toBeUndefined();
    expect((await store.poolPointAtOrBefore('v1:1', at))?.blockHeight).toBe(10);
    await store.insertPoolObservations([
      { ...row, id: 'scan2', blockHeight: 30, blockTimestamp: later, volumesIn: null },
    ]);
    expect((await store.lastPoolPoint('v1:1'))?.blockHeight).toBe(30);
    expect((await store.lastPoolPoint('v1:1', true))?.blockHeight).toBe(20);
    const pool = {
      poolKey: 'v1:1',
      contract: 'v2.ref-finance.near',
      family: 'v1' as const,
      poolType: 'SIMPLE_POOL',
      tokens: ['a', 'b'],
      firstSeenAt: at,
      lastSeenAt: at,
      lastBlockHeight: 10,
      feeBps: 30,
      tvlUsd: '100',
      priceQuality: 'OK',
      category: 'LIQUID',
      modelStatus: 'SUPPORTED',
      reasons: [],
      active: true,
      latest: {},
    };
    await store.upsertPools([pool]);
    await store.upsertPools([{ ...pool, category: 'LOW_LIQUIDITY', lastBlockHeight: 11 }]);
    expect((await store.pool('v1:1'))?.category).toBe('LOW_LIQUIDITY');
    expect(await store.markMissingInactive('v1', [], at)).toBe(1);
    expect((await store.pool('v1:1'))?.active).toBe(false);
  });
});
