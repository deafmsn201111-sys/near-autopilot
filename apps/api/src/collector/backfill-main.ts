import { loadApiEnv } from '@near-autopilot/config';
import { accountIdSchema, assertChainId } from '@near-autopilot/core';
import { createDatabase } from '@near-autopilot/db';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { z } from 'zod';
import { createJsonLogger } from '../logger';
import { HttpJsonClient } from '../market-data/http';
import { runBackfill, v1PoolId, type BackfillTarget } from './backfill';
import { CollectorStore } from './store';

/**
 * One-off HISTORY BACKFILL (mainnet, read-only, view calls at past blocks through an archival RPC). No LLM, no signer.
 *   node --import tsx src/collector/backfill-main.ts [--days 90] [--step-hours 24] [--pools v1:4512,v1:3]
 * Idempotent: points already stored (same pool and block, or a point within --skip-within-hours) are not re-read.
 */
const backfillEnv = z.object({
  MAINNET_ARCHIVAL_RPC_URL: z.string().url().default('https://archival-rpc.mainnet.fastnear.com'),
});

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const env = loadApiEnv();
  if (
    env.NEAR_NETWORK !== 'mainnet' ||
    env.DATA_SOURCE !== 'simulation' ||
    env.EXECUTION_MODE !== 'dry-run'
  )
    throw new Error('the backfill runs only in the shadow profile (mainnet, simulation, dry-run)');
  const { MAINNET_ARCHIVAL_RPC_URL } = backfillEnv.parse(process.env);
  const days = z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .parse(arg('days') ?? 90);
  const stepHours = z.coerce
    .number()
    .int()
    .min(1)
    .max(168)
    .parse(arg('step-hours') ?? 24);
  const skipWithinHours = z.coerce
    .number()
    .min(0)
    .max(48)
    .parse(arg('skip-within-hours') ?? 3);
  const only = arg('pools')?.split(',').filter(Boolean);
  const logger = createJsonLogger(env.LOG_LEVEL);
  // The FastNEAR key of the read RPC is sent to the archival RPC only when that is FastNEAR too (same provider).
  const key =
    new URL(MAINNET_ARCHIVAL_RPC_URL).hostname.endsWith('.fastnear.com') &&
    env.MAINNET_READ_RPC_API_KEY
      ? env.MAINNET_READ_RPC_API_KEY
      : undefined;
  const rpc = new NearRpcClient({
    url: MAINNET_ARCHIVAL_RPC_URL,
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
    maxConcurrent: 2,
    onRetry: (e) =>
      logger.warn('archival rpc retry', { method: e.method, attempt: e.attempt, kind: e.kind }),
  });
  await assertChainId(rpc, 'mainnet');
  const database = createDatabase(env.DATABASE_URL, { max: 2 });
  try {
    const store = new CollectorStore(database.db);
    const targets: BackfillTarget[] = (await store.backfillTargets()).flatMap((p) => {
      const id = v1PoolId(p.poolKey);
      const latest = p.latest as { decimals?: unknown } | null;
      const decimals = z.array(z.number().int().nullable()).safeParse(latest?.decimals);
      if (id === null || !decimals.success || (only && !only.includes(p.poolKey))) return [];
      return [{ poolKey: p.poolKey, poolId: id, tokens: p.tokens, decimals: decimals.data }];
    });
    logger.info('backfill start', {
      pools: targets.length,
      days,
      stepHours,
      keyed: key !== undefined,
    });
    const summary = await runBackfill(
      {
        rpc,
        http: new HttpJsonClient({ maxConcurrent: 2, timeoutMs: 15_000 }),
        defillamaUrl: env.DEFILLAMA_URL,
        coinbaseUrl: env.COINBASE_URL,
        rheaContract: accountIdSchema.parse(env.RHEA_CONTRACT_ID),
        store,
        now: () => new Date(),
        log: (msg, data) => logger.info(msg, data),
      },
      targets,
      { days, stepHours, skipWithinHours },
    );
    logger.info('backfill finished', { ...summary });
  } finally {
    await database.close();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`backfill failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
