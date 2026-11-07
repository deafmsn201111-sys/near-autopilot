import { checkpointAll } from '../evidence/checkpoint';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ControlService } from '../control/service';
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
  /** ed25519 private key (hex) for signed audit checkpoints; never stored in the database. Absent: no checkpoints. */
  AUDIT_CHECKPOINT_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  AUDIT_CHECKPOINT_FILE: z.string().optional(),
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
  const control = new ControlService(database.db);
  // Signed checkpoint of every audit chain head after each cycle (see evidence/checkpoint.ts). A failure is logged and
  // never stops collection: the chain itself is intact either way, only its external anchor is late.
  const checkpoint = async () => {
    if (!c.AUDIT_CHECKPOINT_KEY) return;
    try {
      const made = await checkpointAll(database.db, c.AUDIT_CHECKPOINT_KEY, {
        ...(c.AUDIT_CHECKPOINT_FILE ? { file: c.AUDIT_CHECKPOINT_FILE } : {}),
      });
      if (made.length)
        logger.info('audit checkpoints signed', { chains: made.map((m) => `${m.chain}#${m.seq}`) });
    } catch (e) {
      logger.error('audit checkpoint failed', { error: String(e) });
    }
  };
  let paused = false;
  const status = () => ({
    running: collector.isRunning,
    paused,
    intervalSeconds: c.SHADOW_CYCLE_INTERVAL_SECONDS,
    nextRunAt: nextRunAt.toISOString(),
    last: last && { id: last.id, status: last.status, records: last.records, error: last.error },
  });
  const expected = createHash('sha256').update(env.API_TOKEN).digest();
  const authorised = (h: string | undefined) => {
    const token = h?.startsWith('Bearer ') ? h.slice(7) : '';
    return timingSafeEqual(createHash('sha256').update(token).digest(), expected);
  };
  createServer((req, res) => {
    // On-demand cycle (dashboard "Run market analysis"): token-protected, internal network only, one at a time. It
    // reads mainnet and analyses the simulated portfolios exactly like a scheduled cycle; it never sends anything.
    if (req.url === '/run' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      if (!authorised(req.headers.authorization)) {
        res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (collector.isRunning) {
        res.writeHead(409).end(JSON.stringify({ error: 'a collection cycle is already running' }));
        return;
      }
      void collector
        .runCycle('on_demand')
        .then(async (r) => {
          last = r;
          await checkpoint();
        })
        .catch((e: unknown) => logger.error('on-demand cycle crashed', { error: String(e) }));
      res.writeHead(202).end(JSON.stringify({ started: true, trigger: 'on_demand' }));
      return;
    }
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
      // An operator pause (dashboard, audited) skips SCHEDULED cycles only. If the pause cannot be read, collect as
      // usual: collection is read-only and pausing it is a convenience, not a safety control.
      paused = await control
        .collectorState()
        .then((x) => x.paused)
        .catch(() => false);
      if (paused) logger.info('scheduled collection skipped: paused by an operator');
      else last = await collector.runCycle('scheduled');
      await checkpoint();
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
