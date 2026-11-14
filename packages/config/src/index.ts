import { accountIdSchema, networkSchema, type AccountId } from '@near-autopilot/core';
import { z, type ZodTypeAny } from 'zod';

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Thrown for invalid configuration. Messages list variable names and reasons, never values. */
export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

function parseEnv<S extends ZodTypeAny>(schema: S, source: EnvSource): z.output<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data as z.output<S>;
}

const MAINNET_DEFAULTS = {
  RHEA_CONTRACT_ID: 'v2.ref-finance.near',
  BURROW_CONTRACT_ID: 'contract.main.burrow.near',
  BURROW_ORACLE_ID: 'priceoracle.near',
} as const;

/** Unset and empty (`FOO=`, or compose's `${FOO:-}`) both mean "not provided". */
const optionalAccountId = z.preprocess(
  (v) => (v === '' ? undefined : v),
  accountIdSchema.optional(),
);

const apiEnvRaw = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  /** Shared secret for the dashboard -> API calls. */
  API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  DATABASE_URL: z.string().url(),
  NEAR_NETWORK: networkSchema,
  NEAR_RPC_URL: z.string().url(),
  /** Optional key for a hosted RPC (e.g. FastNEAR), sent as `Authorization: Bearer`. Local .env only; never logged. */
  NEAR_RPC_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  AUTOPILOT_ACCOUNT_ID: accountIdSchema,
  /** `dry-run` plans and evaluates policy but never signs or broadcasts. */
  EXECUTION_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
  MARKET_CONFIG_FILE: z.string().min(1).default('./config/market.json'),
  /**
   * `legacy`: packages/agents (health guardian + optional rebalancer) through services/cycle.
   * `orchestrator`: packages/orchestrator (multi-agent decision engine). Its stores are in-memory, so it is dry-run only.
   */
  AUTOPILOT_ENGINE: z.enum(['legacy', 'orchestrator']).default('legacy'),
  /**
   * `chain`: read the configured NEAR network. `simulation`: a deterministic demo portfolio, no network access at all;
   * every result is labelled simulated. Simulation is dry-run only.
   */
  DATA_SOURCE: z.enum(['chain', 'simulation']).default('chain'),
  SIMULATION_PORTFOLIO: z.enum(['demo-500', 'demo-5000']).default('demo-500'),
  RHEA_CONTRACT_ID: optionalAccountId,
  BURROW_CONTRACT_ID: optionalAccountId,
  BURROW_ORACLE_ID: optionalAccountId,
  /**
   * `none`: prices come from the Burrow oracle only.
   * `mainnet-live`: Pyth, DefiLlama and exchange prices for the simulated shadow analysis (simulation + dry-run).
   */
  MARKET_DATA: z.enum(['none', 'mainnet-live']).default('none'),
  /**
   * `none`: no yield data (the Capital Allocator reports missing yields).
   * `mainnet-onchain`: Burrow rates, Rhea v1 pool fees and Rhea DCL pool state read from mainnet contracts (read-only
   * views at one pinned block). Requires MARKET_DATA=mainnet-live.
   */
  YIELD_DATA: z.enum(['none', 'mainnet-onchain']).default('none'),
  /**
   * Read-only MAINNET RPC for the shadow analysis (MARKET_DATA=mainnet-live, YIELD_DATA=mainnet-onchain): view calls
   * only; the API checks at start-up that it serves mainnet. Never used to sign or broadcast; no signer exists.
   */
  MAINNET_READ_RPC_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
  /** Optional key for that RPC (e.g. FastNEAR), sent as `Authorization: Bearer`. Local .env only; never logged. */
  MAINNET_READ_RPC_API_KEY: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(8).optional(),
  ),
  /** Rhea DCL contract to observe (optional; empty = DCL not read). */
  RHEA_DCL_CONTRACT_ID: optionalAccountId,
  /** Pyth Hermes requires an API key since Aug 2026. Read from the local .env only; never logged. */
  PYTH_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  PYTH_HERMES_URL: z.string().url().default('https://hermes.pyth.network'),
  DEFILLAMA_URL: z.string().url().default('https://coins.llama.fi'),
  /** Public exchange market data (no key): last-trade prices, the independent NEAR/USD quorum. */
  COINBASE_URL: z.string().url().default('https://api.exchange.coinbase.com'),
  KRAKEN_URL: z.string().url().default('https://api.kraken.com'),
  BINANCE_URL: z.string().url().default('https://data-api.binance.vision'),
  /**
   * NEAR Intents 1Click API, DRY quotes only (no JWT, no deposit address), used by the Shadow Gateway on mainnet
   * market data. Empty = 1Click is not quoted.
   */
  ONE_CLICK_URL: z
    .union([z.literal(''), z.string().url()])
    .default('https://1click.chaindefuser.com'),
  /**
   * Existing MAINNET account a 1Click dry quote is addressed to (1Click refuses accounts that do not exist). Nothing
   * is ever sent to it. Unset or empty = AUTOPILOT_ACCOUNT_ID.
   */
  ONE_CLICK_QUOTE_ACCOUNT: optionalAccountId,
});

export interface ApiEnv {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly API_HOST: string;
  readonly API_PORT: number;
  readonly API_TOKEN: string;
  readonly DATABASE_URL: string;
  readonly NEAR_NETWORK: 'mainnet';
  readonly NEAR_RPC_URL: string;
  readonly NEAR_RPC_API_KEY: string | undefined;
  readonly AUTOPILOT_ACCOUNT_ID: AccountId;
  readonly EXECUTION_MODE: 'dry-run' | 'live';
  readonly MARKET_CONFIG_FILE: string;
  readonly AUTOPILOT_ENGINE: 'legacy' | 'orchestrator';
  readonly DATA_SOURCE: 'chain' | 'simulation';
  readonly SIMULATION_PORTFOLIO: 'demo-500' | 'demo-5000';
  readonly RHEA_CONTRACT_ID: AccountId;
  readonly BURROW_CONTRACT_ID: AccountId;
  readonly BURROW_ORACLE_ID: AccountId;
  readonly MARKET_DATA: 'none' | 'mainnet-live';
  readonly YIELD_DATA: 'none' | 'mainnet-onchain';
  readonly MAINNET_READ_RPC_URL: string | undefined;
  readonly MAINNET_READ_RPC_API_KEY: string | undefined;
  readonly RHEA_DCL_CONTRACT_ID: AccountId | undefined;
  readonly PYTH_API_KEY: string | undefined;
  readonly PYTH_HERMES_URL: string;
  readonly DEFILLAMA_URL: string;
  readonly COINBASE_URL: string;
  readonly KRAKEN_URL: string;
  readonly BINANCE_URL: string;
  /** '' when disabled. */
  readonly ONE_CLICK_URL: string;
  /** undefined = AUTOPILOT_ACCOUNT_ID. */
  readonly ONE_CLICK_QUOTE_ACCOUNT: AccountId | undefined;
}

export const apiEnvSchema = apiEnvRaw.superRefine((env, ctx) => {
  // Hard rule: the server never signs. There is no override.
  if (env.EXECUTION_MODE === 'live') {
    ctx.addIssue({
      code: 'custom',
      path: ['EXECUTION_MODE'],
      message: 'live execution is refused on mainnet (no server signing keys, ever); use dry-run',
    });
  }
  if (env.EXECUTION_MODE === 'live' && env.AUTOPILOT_ENGINE === 'orchestrator') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTOPILOT_ENGINE'],
      message:
        'the orchestrator engine keeps its audit/idempotency state in memory and is dry-run only',
    });
  }
  if (env.EXECUTION_MODE === 'live' && env.DATA_SOURCE === 'simulation') {
    ctx.addIssue({
      code: 'custom',
      path: ['DATA_SOURCE'],
      message: 'simulation never executes: use EXECUTION_MODE=dry-run',
    });
  }
  if (env.MARKET_DATA === 'mainnet-live') {
    // Shadow analysis: real mainnet prices for a SIMULATED portfolio. Nothing is ever executed.
    const why =
      env.DATA_SOURCE !== 'simulation'
        ? 'DATA_SOURCE=simulation'
        : env.EXECUTION_MODE !== 'dry-run'
          ? 'EXECUTION_MODE=dry-run'
          : null;
    if (why)
      ctx.addIssue({
        code: 'custom',
        path: ['MARKET_DATA'],
        message: `mainnet live prices are for the simulated shadow analysis only: requires ${why}`,
      });
  }
  if (env.YIELD_DATA === 'mainnet-onchain') {
    if (env.MARKET_DATA !== 'mainnet-live')
      ctx.addIssue({
        code: 'custom',
        path: ['YIELD_DATA'],
        message: 'mainnet yield data requires MARKET_DATA=mainnet-live (simulation, dry-run)',
      });
    if (!env.MAINNET_READ_RPC_URL)
      ctx.addIssue({
        code: 'custom',
        path: ['MAINNET_READ_RPC_URL'],
        message: 'required when YIELD_DATA=mainnet-onchain',
      });
  }
  if (env.MARKET_DATA === 'mainnet-live' && !env.MAINNET_READ_RPC_URL)
    ctx.addIssue({
      code: 'custom',
      path: ['MAINNET_READ_RPC_URL'],
      message:
        'required when MARKET_DATA=mainnet-live (mainnet token decimals are verified on-chain)',
    });
});

export function loadApiEnv(source: EnvSource = process.env): ApiEnv {
  const env = parseEnv(apiEnvSchema, source);
  const pick = (key: keyof typeof MAINNET_DEFAULTS): AccountId =>
    env[key] ?? (MAINNET_DEFAULTS[key] as AccountId);
  return {
    NODE_ENV: env.NODE_ENV,
    LOG_LEVEL: env.LOG_LEVEL,
    API_HOST: env.API_HOST,
    API_PORT: env.API_PORT,
    API_TOKEN: env.API_TOKEN,
    DATABASE_URL: env.DATABASE_URL,
    NEAR_NETWORK: env.NEAR_NETWORK,
    NEAR_RPC_URL: env.NEAR_RPC_URL,
    NEAR_RPC_API_KEY: env.NEAR_RPC_API_KEY,
    AUTOPILOT_ACCOUNT_ID: env.AUTOPILOT_ACCOUNT_ID,
    EXECUTION_MODE: env.EXECUTION_MODE,
    MARKET_CONFIG_FILE: env.MARKET_CONFIG_FILE,
    AUTOPILOT_ENGINE: env.AUTOPILOT_ENGINE,
    DATA_SOURCE: env.DATA_SOURCE,
    SIMULATION_PORTFOLIO: env.SIMULATION_PORTFOLIO,
    RHEA_CONTRACT_ID: pick('RHEA_CONTRACT_ID'),
    BURROW_CONTRACT_ID: pick('BURROW_CONTRACT_ID'),
    BURROW_ORACLE_ID: pick('BURROW_ORACLE_ID'),
    MARKET_DATA: env.MARKET_DATA,
    YIELD_DATA: env.YIELD_DATA,
    MAINNET_READ_RPC_URL: env.MAINNET_READ_RPC_URL,
    MAINNET_READ_RPC_API_KEY: env.MAINNET_READ_RPC_API_KEY,
    RHEA_DCL_CONTRACT_ID: env.RHEA_DCL_CONTRACT_ID,
    PYTH_API_KEY: env.PYTH_API_KEY,
    PYTH_HERMES_URL: env.PYTH_HERMES_URL,
    DEFILLAMA_URL: env.DEFILLAMA_URL,
    COINBASE_URL: env.COINBASE_URL,
    KRAKEN_URL: env.KRAKEN_URL,
    BINANCE_URL: env.BINANCE_URL,
    ONE_CLICK_URL: env.ONE_CLICK_URL,
    ONE_CLICK_QUOTE_ACCOUNT: env.ONE_CLICK_QUOTE_ACCOUNT,
  };
}

export const dashboardEnvSchema = z.object({
  /** Base URL of the API, reachable from the dashboard's server (not the browser). */
  API_BASE_URL: z.string().url(),
  API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  /** Only the loopback admin site (ADMIN_UI=1) gets it; the public site has none. */
  ADMIN_API_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'must be at least 32 characters').optional(),
  ),
});
export type DashboardEnv = z.output<typeof dashboardEnvSchema>;

export function loadDashboardEnv(source: EnvSource = process.env): DashboardEnv {
  return parseEnv(dashboardEnvSchema, source);
}

/** Unset and empty both mean "not provided". */
const unsetIfEmpty = (v: unknown) => (v === '' ? undefined : v);

/** The models the server or the legacy comparison utility may call; each has a price in apps/api/src/llm/pricing.ts. */
export const ANTHROPIC_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'] as const;
export const NEAR_AI_MODELS = ['deepseek/deepseek-v4.1-flash', 'Qwen/Qwen3.8-27B'] as const;
export const LLM_MODELS = [...ANTHROPIC_MODELS, ...NEAR_AI_MODELS] as const;
export type LlmModel = (typeof LLM_MODELS)[number];

/** Server analysis LLM (NEAR AI Cloud). No key = LLM off, heuristics only; the key is never logged. */
export const nearAiEnvSchema = z.object({
  NEAR_AI_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(8).optional()),
  NEAR_AI_MODEL: z.preprocess(
    unsetIfEmpty,
    z
      .enum(NEAR_AI_MODELS, { message: `must be one of ${NEAR_AI_MODELS.join(', ')}` })
      .default('deepseek/deepseek-v4.1-flash'),
  ),
  NEAR_AI_MAX_TOKENS: z.preprocess(
    unsetIfEmpty,
    z.coerce.number().int().min(1).max(16_000).default(4096),
  ),
});
export type NearAiEnv = z.output<typeof nearAiEnvSchema>;

/** Legacy Anthropic settings used only by the comparison utility, not the server analysis path. */
export const llmEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(unsetIfEmpty, z.string().min(8).optional()),
  ANTHROPIC_MODEL: z.preprocess(
    unsetIfEmpty,
    z
      .enum(ANTHROPIC_MODELS, { message: `must be one of ${ANTHROPIC_MODELS.join(', ')}` })
      .default('claude-haiku-5-5'),
  ),
  /** Hard cap on one reply; also bounds the spend of a single call. */
  ANTHROPIC_MAX_TOKENS: z.preprocess(
    unsetIfEmpty,
    z.coerce.number().int().min(1).max(16_000).default(4096),
  ),
  /** Spend per UTC day; a DB setting overrides it. Once reached, everyone gets the rule-based list. */
  LLM_DAILY_CAP_USD: z.preprocess(unsetIfEmpty, z.coerce.number().min(0).max(1_000).default(5)),
});
export type LlmEnv = z.output<typeof llmEnvSchema>;

/**
 * 1Click partner JWT for real deposit quotes (D19). Unset = 1Click's keyless fee schedule. Read from the local .env only,
 * sent only to 1Click as a bearer header; never logged, never in a response.
 */
export const oneClickEnvSchema = z.object({
  ONE_CLICK_JWT: z.preprocess(
    unsetIfEmpty,
    z
      .string()
      .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'must be a JWT (three base64url parts)')
      .min(16)
      .max(4096)
      .optional(),
  ),
});
export type OneClickEnv = z.output<typeof oneClickEnvSchema>;

export const databaseEnvSchema = z.object({ DATABASE_URL: z.string().url() });
export type DatabaseEnv = z.output<typeof databaseEnvSchema>;

export function loadDatabaseEnv(source: EnvSource = process.env): DatabaseEnv {
  return parseEnv(databaseEnvSchema, source);
}
