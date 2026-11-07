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
import { systemClock, uuidGenerator, wire, type WireOptions } from './wiring';
import { UserRequestService } from './services/requests';
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

  const wireOptions: WireOptions = {
    marketSink: new DrizzleMarketPriceStore(database.db),
    yieldSink: new AuditedYieldSink(new DrizzleYieldStore(database.db), repo),
    // Durable mode and idempotency: an emergency read-only survives a restart (migration 0013).
    orchestratorStores: (scope) => ({
      control: new PgControlStore(database.db, scope, chainOf(provenance), systemClock),
      idempotency: new PgIdempotencyStore(database.db, scope, systemClock),
    }),
  };
  const wired = await wire(env, config, repo, logger, wireOptions);
  const { cycle, snapshots, policy, market, yields, control } = wired;

  // "Let the agent do it": one request service per simulated demo portfolio, through the SAME planners, policy
  // engine and executor (dry-run) as the cycles. Only in simulation; the other portfolio is wired on first use.
  const services = new Map<string, Promise<UserRequestService>>();
  const serviceOf = (w: typeof wired, portfolio: string) =>
    new UserRequestService({
      portfolio,
      policy: w.policy,
      planners: w.planners,
      executor: w.executor,
      snapshots: w.snapshots,
      repo,
      accountId: w.accountId,
      clock: systemClock,
      ids: uuidGenerator,
      logger,
    });
  const requests =
    env.DATA_SOURCE === 'simulation' && env.EXECUTION_MODE === 'dry-run'
      ? (portfolio: string) => {
          if (portfolio !== 'demo-500' && portfolio !== 'demo-5000') return Promise.resolve(null);
          let s = services.get(portfolio);
          if (!s) {
            s =
              portfolio === env.SIMULATION_PORTFOLIO
                ? Promise.resolve(serviceOf(wired, portfolio))
                : wire(
                    { ...env, SIMULATION_PORTFOLIO: portfolio },
                    config,
                    repo,
                    logger,
                    wireOptions,
                  ).then((w) => serviceOf(w, portfolio));
            services.set(portfolio, s);
          }
          return s;
        }
      : undefined;
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
      ...(requests ? { requests } : {}),
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
