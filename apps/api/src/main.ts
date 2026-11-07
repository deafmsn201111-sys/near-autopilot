import { EvidenceStore } from './evidence/store';
import { loadApiEnv, EnvValidationError } from '@near-autopilot/config';
import { createDatabase, runMigrations } from '@near-autopilot/db';
import { loadAutopilotConfig } from './autopilot-config';
import { DrizzleRepository } from './infra/drizzle-repository';
import { createJsonLogger } from './logger';
import { toPolicyDto } from './presenters';
import { buildServer } from './server';
import { marketDataView } from './market-data/presenter';
import { DrizzleMarketPriceStore } from './market-data/store';
import { yieldDataView } from './yield/presenter';
import { AuditedYieldSink } from './yield/audit';
import { DrizzleYieldStore } from './yield/store';
import { DrizzleTestnetTxLedger } from './testnet-tx/ledger';
import { testnetTxView } from './testnet-tx/presenter';
import { systemClock, wire } from './wiring';
import { chainOf } from './evidence/chain';
import { PgControlStore, PgIdempotencyStore } from './infra/orchestrator-stores';
import { ModeController } from '@near-autopilot/orchestrator';

async function main(): Promise<void> {
  const env = loadApiEnv();
  const logger = createJsonLogger(env.LOG_LEVEL);
  const config = loadAutopilotConfig(env.AUTOPILOT_CONFIG_FILE, env.AUTOPILOT_ACCOUNT_ID);

  const database = createDatabase(env.DATABASE_URL);
  await runMigrations(database.db);
  const provenance = { dataSource: env.DATA_SOURCE, network: env.NEAR_NETWORK } as const;
  const repo = new DrizzleRepository(database.db, provenance);

  const { cycle, snapshots, policy, market, yields, control } = await wire(
    env,
    config,
    repo,
    logger,
    {
      marketSink: new DrizzleMarketPriceStore(database.db),
      yieldSink: new AuditedYieldSink(new DrizzleYieldStore(database.db), repo),
      // Durable mode and idempotency: an emergency read-only survives a restart (migration 0013).
      orchestratorStores: (scope) => ({
        control: new PgControlStore(database.db, scope, chainOf(provenance), systemClock),
        idempotency: new PgIdempotencyStore(database.db, scope, systemClock),
      }),
    },
  );
  if (control) {
    // Restart recovery, audited: which mode this process starts in, as read from the database.
    const state = await new ModeController(control.store, systemClock).current();
    await repo.appendAudit({
      at: systemClock.now(),
      type: 'orchestrator.control.restored',
      runId: null,
      proposalId: null,
      payload: {
        scope: control.scope,
        mode: state.mode,
        reason: state.reason,
        since: state.since.toISOString(),
      },
    });
    logger.info('orchestrator control state restored', { scope: control.scope, mode: state.mode });
  }
  const app = buildServer(
    {
      apiToken: env.API_TOKEN,
      repo,
      snapshots,
      cycle,
      policy: toPolicyDto(policy.config, config.guardian, {
        ...provenance,
        executionMode: env.EXECUTION_MODE,
        engine: env.AUTOPILOT_ENGINE,
        simulationPortfolio: env.DATA_SOURCE === 'simulation' ? env.SIMULATION_PORTFOLIO : null,
        marketData: env.MARKET_DATA,
      }),
      provenance,
      testnetTransactions: testnetTxView(new DrizzleTestnetTxLedger(database.db)),
      evidence: new EvidenceStore(database.db),
      marketData: marketDataView(market, env.NEAR_NETWORK),
      yieldData: yieldDataView(yields),
    },
    { logger: { level: env.LOG_LEVEL } },
  );

  let timer: NodeJS.Timeout | undefined;
  if (env.CYCLE_INTERVAL_SECONDS > 0) {
    timer = setInterval(() => {
      if (cycle.isRunning) return;
      cycle
        .run()
        .catch((error: unknown) =>
          logger.error('scheduled cycle crashed', { error: String(error) }),
        );
    }, env.CYCLE_INTERVAL_SECONDS * 1000);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    if (timer) clearInterval(timer);
    await app.close();
    await database.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info('autopilot api started', {
    mode: env.EXECUTION_MODE,
    network: env.NEAR_NETWORK,
    dataSource: env.DATA_SOURCE,
    engine: env.AUTOPILOT_ENGINE,
    marketData:
      env.MARKET_DATA === 'mainnet-reference'
        ? 'MAINNET MARKET DATA → TESTNET EXECUTION'
        : env.MARKET_DATA === 'mainnet-live'
          ? 'MAINNET READ-ONLY DATA → SIMULATED PORTFOLIO (NO EXECUTION)'
          : 'none',
    mainnetReadRpc: env.MAINNET_READ_RPC_URL ? 'set' : 'not set',
    pythKey: env.PYTH_API_KEY ? 'set' : 'not set',
    yieldData: env.YIELD_DATA,
    account: env.AUTOPILOT_ACCOUNT_ID,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof EnvValidationError ? error.message : error);
  process.exit(1);
});
