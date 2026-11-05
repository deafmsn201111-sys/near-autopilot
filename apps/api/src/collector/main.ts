import { collectorRouteProbe } from '../gateway/probe';
import { createServer } from 'node:http';
import { loadApiEnv } from '@near-autopilot/config';
import { createDatabase } from '@near-autopilot/db';
import { z } from 'zod';
import { loadAutopilotConfig } from '../autopilot-config';
import { DrizzleRepository } from '../infra/drizzle-repository';
import { createJsonLogger } from '../logger';
import { HttpJsonClient } from '../market-data/http';
import { DrizzleMarketPriceStore } from '../market-data/store';
import { shadowSources, uuidGenerator } from '../wiring';
import { AuditedYieldSink } from '../yield/audit';
import { DrizzleYieldStore } from '../yield/store';
import { ShadowCollector, type CycleSummary } from './collector';
import { DEFAULT_FILTER } from './model';
import { CollectorStore } from './store';

/**
 * AUTONOMOUS SHADOW COLLECTOR. A plain Node process: no LLM, no AI assistant, no browser. Reads mainnet (views only) and
 * public price APIs on a schedule, stores everything in Postgres, and analyses both demo portfolios per snapshot.
 *   node --import tsx src/collector/main.ts          # schedule (SHADOW_CYCLE_INTERVAL_SECONDS)
 *   node --import tsx src/collector/main.ts --once   # one on-demand cycle, then exit
 */
const collectorEnv = z.object({
  SHADOW_CYCLE_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
  COLLECTOR_REGISTRY_EVERY: z.coerce.number().int().min(1).default(4),
  COLLECTOR_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  COLLECTOR_MIN_TVL_USD: z.coerce.number().min(0).default(DEFAULT_FILTER.minTvlUsd),
  COLLECTOR_HORIZON_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const env = loadApiEnv();
  const c = collectorEnv.parse(process.env);
  const logger = createJsonLogger(env.LOG_LEVEL);
  const config = loadAutopilotConfig(env.AUTOPILOT_CONFIG_FILE, env.AUTOPILOT_ACCOUNT_ID);
  const database = createDatabase(env.DATABASE_URL, { max: 4 });
  const provenance = { dataSource: env.DATA_SOURCE, network: env.NEAR_NETWORK } as const;
  const repo = new DrizzleRepository(database.db, provenance);
  const store = new CollectorStore(database.db);
  const sources = await shadowSources(env, config, logger, {
    marketSink: new DrizzleMarketPriceStore(database.db),
    yieldSink: new AuditedYieldSink(new DrizzleYieldStore(database.db), repo),
  });
  const orchestrator = config.orchestrator;
  const collector = new ShadowCollector({
    env,
    config,
    rpc: sources.rpc,
    market: sources.market,
    yields: sources.yields,
    http: new HttpJsonClient({ maxConcurrent: 2, timeoutMs: 15_000 }),
    store,
    repo,
    logger,
    now: () => new Date(),
    ids: () => uuidGenerator.next(),
    filter: {
      ...DEFAULT_FILTER,
      minTvlUsd: c.COLLECTOR_MIN_TVL_USD,
      maxPriceDeviationBps: config.policy.maxOracleDeviationBps,
    },
    limits: {
      maxAprBps: config.yield?.maxAprBps ?? 10_000,
      maxUtilizationBps: config.yield?.maxUtilizationBps ?? 9_500,
      minLiquidityUsd: config.yield?.minLiquidityUsd ?? 1_000,
      maxAgeSeconds: orchestrator?.freshness?.maxMarketAgeSeconds ?? 300,
    },
    registryEvery: c.COLLECTOR_REGISTRY_EVERY,
    registryMaxAgeSeconds: c.COLLECTOR_REGISTRY_EVERY * c.SHADOW_CYCLE_INTERVAL_SECONDS,
    portfolios: ['demo-500', 'demo-5000'],
    horizonDays: c.COLLECTOR_HORIZON_DAYS,
    gasUsdPerTx: orchestrator?.swap?.estimatedGasUsd ?? 0.05,
    dclContract: env.RHEA_DCL_CONTRACT_ID ?? null,
    routeProbe: collectorRouteProbe({
      env,
      config,
      repo,
      logger,
      ids: () => uuidGenerator.next(),
      now: () => new Date(),
    }),
  });
  await store.closeAbandoned(new Date());

  if (once) {
    const r = await collector.runCycle('on_demand');
    logger.info('collector on-demand cycle', { status: r.status, records: r.records });
    await database.close();
    process.exit(r.status === 'failed' ? 1 : 0);
  }

  let last: CycleSummary | null = null;
  let nextRunAt = new Date();
  const status = () => ({
    running: collector.isRunning,
    intervalSeconds: c.SHADOW_CYCLE_INTERVAL_SECONDS,
    nextRunAt: nextRunAt.toISOString(),
    last: last && { id: last.id, status: last.status, records: last.records, error: last.error },
  });
  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status()));
      return;
    }
    res.writeHead(404).end();
  }).listen(c.COLLECTOR_HEALTH_PORT, '0.0.0.0');

  let stopping = false;
  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      last = await collector.runCycle('scheduled');
    } catch (e) {
      logger.error('collector tick crashed', { error: String(e) });
    }
    nextRunAt = new Date(Date.now() + c.SHADOW_CYCLE_INTERVAL_SECONDS * 1000);
    setTimeout(() => void tick(), c.SHADOW_CYCLE_INTERVAL_SECONDS * 1000);
  };
  const stop = async (signal: string) => {
    stopping = true;
    logger.info('collector stopping', { signal });
    await database.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  logger.info('shadow collector started', {
    mode: 'MAINNET READ-ONLY, NO TRANSACTIONS',
    intervalSeconds: c.SHADOW_CYCLE_INTERVAL_SECONDS,
    registryEvery: c.COLLECTOR_REGISTRY_EVERY,
    pyth: env.PYTH_API_KEY ? 'key set' : 'no key',
    mainnetReadRpc: env.MAINNET_READ_RPC_URL ? 'set' : 'not set',
  });
  void tick();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `collector failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
