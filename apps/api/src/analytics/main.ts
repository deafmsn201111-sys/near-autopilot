import { readFileSync } from 'node:fs';
import { llmEnvSchema, oneClickEnvSchema } from '@near-autopilot/config';
import { accountId } from '@near-autopilot/core';
import { NearContractViewer, NearRpcClient } from '@near-autopilot/near-adapter';
import { createDatabase, runMigrations } from '@near-autopilot/db';
import { z } from 'zod';
import { CollectorStore } from '../collector/store';
import { EvidenceStore } from '../evidence/store';
import { OneClickDepositClient } from '../gateway/one-click-deposit';
import { HttpJsonClient } from '../market-data/http';
import { anthropicToolLlmFromEnv } from '../llm/anthropic-client';
import { analysisMemo } from './ai-analysis';
import { DrizzleDepositQuoteStore } from './deposit-store';
import { DrizzleEventStore } from './events-store';
import { httpDiscovery } from './discovery';
import { DrizzleLlmLedger } from './llm-ledger';
import { buildAnalyticsServer } from './server';
import { TokenIcons } from './token-icons';

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
    /** Only the loopback admin site holds it; unset or empty = the admin routes answer 401. */
    ADMIN_API_TOKEN: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(32).optional()),
  })
  .refine((e) => e.ADMIN_API_TOKEN !== e.API_TOKEN, 'ADMIN_API_TOKEN must differ from API_TOKEN')
  .parse(process.env);
// Parsed on every start, so a model outside the allowlist stops the API even when the wallet path is off.
const llmEnv = llmEnvSchema.parse(process.env);

const database = createDatabase(env.DATABASE_URL, { max: 4 });
// The only process that migrates: the collector waits for this API to be healthy before it starts.
await runMigrations(database.db);
const defaultCapMicro = BigInt(Math.round(llmEnv.LLM_DAILY_CAP_USD * 1e6));
const llmLedger = new DrizzleLlmLedger(database.db, defaultCapMicro);
const toolLlm = anthropicToolLlmFromEnv(llmEnv);
// The allowlisted pools are the execution allowlist of the shadow config: the only swaps an action may assume.
const market = env.MARKET_CONFIG_FILE
  ? (JSON.parse(readFileSync(env.MARKET_CONFIG_FILE, 'utf8')) as {
      rhea?: { pools?: { poolId: number; tokenA: string; tokenB: string }[]; dclPools?: string[] };
      policy?: { allowedTokens?: string[] };
    })
  : {};
const pools = market.rhea?.pools ?? [];
const { ONE_CLICK_JWT } = oneClickEnvSchema.parse(process.env);
const depositQuotes = new DrizzleDepositQuoteStore(database.db);
// No retry: every real quote mints a new deposit address, and the user must see exactly one.
const oneClick = new OneClickDepositClient({
  http: new HttpJsonClient({ maxRetries: 0, timeoutMs: 15_000 }),
  jwt: ONE_CLICK_JWT,
});
const events = new DrizzleEventStore(database.db);
// The tokens a deposit may arrive as: our own allowlist, never user input.
const destinationTokens = market.policy?.allowedTokens ?? [];
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
      dclPools: market.rhea?.dclPools ?? [],
      discovery: httpDiscovery(),
      ai: toolLlm
        ? {
            llm: toolLlm,
            model: llmEnv.ANTHROPIC_MODEL,
            maxTokens: llmEnv.ANTHROPIC_MAX_TOKENS,
            ledger: llmLedger,
            memo: analysisMemo(),
          }
        : null,
    }
  : undefined;
const icons = mainnet ? new TokenIcons(new NearContractViewer(mainnet.rpc)) : undefined;
const app = buildAnalyticsServer(
  {
    apiToken: env.API_TOKEN,
    store: new CollectorStore(database.db),
    evidence: new EvidenceStore(database.db),
    events,
    intervalSeconds: env.SHADOW_CYCLE_INTERVAL_SECONDS,
    ...(mainnet ? { mainnet } : {}),
    ...(icons ? { icons } : {}),
    ...(env.ADMIN_API_TOKEN
      ? {
          admin: {
            token: env.ADMIN_API_TOKEN,
            store: llmLedger,
            defaultCapMicro,
            events,
            deposits: { store: depositQuotes, tokens: () => oneClick.tokens() },
          },
        }
      : {}),
    ...(destinationTokens.length
      ? {
          deposit: {
            oneClick,
            store: depositQuotes,
            destinationTokens,
            ...(icons ? { icon: (t: string) => icons.get(t) } : {}),
          },
        }
      : {}),
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
const purge = () =>
  Promise.all([
    llmLedger.purge().catch((err: unknown) => app.log.warn({ err }, 'llm_calls purge failed')),
    depositQuotes
      .purge()
      .catch((err: unknown) => app.log.warn({ err }, 'deposit_quotes purge failed')),
    events.purge().catch((err: unknown) => app.log.warn({ err }, 'events purge failed')),
  ]);
await purge();
const purgeTimer = setInterval(() => void purge(), 60 * 60 * 1000);
const stop = async () => {
  clearInterval(purgeTimer);
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
await app.listen({ host: env.API_HOST, port: env.API_PORT });
