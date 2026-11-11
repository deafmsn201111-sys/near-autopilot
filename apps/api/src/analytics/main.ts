import { readFileSync } from 'node:fs';
import { accountId } from '@near-autopilot/core';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { createDatabase, runMigrations } from '@near-autopilot/db';
import { z } from 'zod';
import { CollectorStore } from '../collector/store';
import { EvidenceStore } from '../evidence/store';
import { buildAnalyticsServer } from './server';

/**
 * Read-only analytics API (Postgres only). It needs no RPC, no price API and no key other than the shared API token;
 * it keeps serving the last stored data when the collector is down.
 */
const env = z
  .object({
    DATABASE_URL: z.string().url(),
    API_TOKEN: z.string().min(32),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().default(4000),
    SHADOW_CYCLE_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(900),
    AUDIT_CHECKPOINT_PUBLIC_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    AUDIT_CHECKPOINT_FILE: z.string().optional(),
    /** Read-only mainnet RPC for "your account" (the same private key as the collector). */
    MAINNET_READ_RPC_URL: z.string().url().optional(),
    MAINNET_READ_RPC_API_KEY: z.string().optional(),
    MARKET_CONFIG_FILE: z.string().optional(),
  })
  .parse(process.env);

const database = createDatabase(env.DATABASE_URL, { max: 4 });
// The only process that migrates: the collector waits for this API to be healthy before it starts.
await runMigrations(database.db);
// The allowlisted pools are the execution allowlist of the shadow config: the only swaps an action may assume.
const pools = env.MARKET_CONFIG_FILE
  ? ((
      JSON.parse(readFileSync(env.MARKET_CONFIG_FILE, 'utf8')) as {
        rhea?: { pools?: { poolId: number; tokenA: string; tokenB: string }[] };
      }
    ).rhea?.pools ?? [])
  : [];
const mainnet = env.MAINNET_READ_RPC_URL
  ? {
      rpc: new NearRpcClient({
        url: env.MAINNET_READ_RPC_URL,
        // never logged; only sent to the provider that issued it
        headers: env.MAINNET_READ_RPC_API_KEY
          ? { authorization: `Bearer ${env.MAINNET_READ_RPC_API_KEY}` }
          : undefined,
        maxConcurrent: 4,
      }),
      burrowId: accountId('contract.main.burrow.near'),
      rheaId: accountId('v2.ref-finance.near'),
      dclId: accountId('dclv2.ref-labs.near'),
      pools: pools.map((p) => ({
        poolId: p.poolId,
        tokenA: accountId(p.tokenA),
        tokenB: accountId(p.tokenB),
      })),
    }
  : undefined;
const app = buildAnalyticsServer(
  {
    apiToken: env.API_TOKEN,
    store: new CollectorStore(database.db),
    evidence: new EvidenceStore(database.db),
    intervalSeconds: env.SHADOW_CYCLE_INTERVAL_SECONDS,
    ...(mainnet ? { mainnet } : {}),
    ...(env.AUDIT_CHECKPOINT_PUBLIC_KEY
      ? {
          checkpoints: {
            publicKey: env.AUDIT_CHECKPOINT_PUBLIC_KEY,
            file: env.AUDIT_CHECKPOINT_FILE,
          },
        }
      : {}),
  },
  { logger: true },
);
const stop = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
await app.listen({ host: env.API_HOST, port: env.API_PORT });
