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
  /** 0 disables the scheduler; cycles can still be triggered via the API. */
  CYCLE_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(0),
  AUTOPILOT_CONFIG_FILE: z.string().min(1).default('./config/autopilot.json'),
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
   * `none`: prices come from the Burrow oracle of NEAR_NETWORK only.
   * `mainnet-reference`: MAINNET market data (Pyth, then DefiLlama) priced onto TESTNET tokens as conditional
   * REFERENCE prices. Testnet + chain + dry-run only: a mainnet price never confirms a testnet token's value.
   */
  MARKET_DATA: z.enum(['none', 'mainnet-reference']).default('none'),
  /**
   * `none`: no yield data (the Capital Allocator reports missing yields).
   * `testnet-onchain`: Burrow rates, Rhea v1 pool fees and Rhea DCL pool state read from TESTNET contracts (read-only
   * views at one pinned block). Testnet + chain + dry-run + mainnet-reference prices only.
   */
  YIELD_DATA: z.enum(['none', 'testnet-onchain']).default('none'),
  /** Rhea DCL contract to observe (optional; empty = DCL not read). */
  RHEA_DCL_CONTRACT_ID: optionalAccountId,
  /** Pyth Hermes requires an API key since Aug 2026. Read from the local .env only; never logged. */
  PYTH_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(8).optional()),
  PYTH_HERMES_URL: z.string().url().default('https://hermes.pyth.network'),
  DEFILLAMA_URL: z.string().url().default('https://coins.llama.fi'),
});

export interface ApiEnv {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly API_HOST: string;
  readonly API_PORT: number;
  readonly API_TOKEN: string;
  readonly DATABASE_URL: string;
  readonly NEAR_NETWORK: 'mainnet' | 'testnet';
  readonly NEAR_RPC_URL: string;
  readonly NEAR_RPC_API_KEY: string | undefined;
  readonly AUTOPILOT_ACCOUNT_ID: AccountId;
  readonly EXECUTION_MODE: 'dry-run' | 'live';
  readonly CYCLE_INTERVAL_SECONDS: number;
  readonly AUTOPILOT_CONFIG_FILE: string;
  readonly AUTOPILOT_ENGINE: 'legacy' | 'orchestrator';
  readonly DATA_SOURCE: 'chain' | 'simulation';
  readonly SIMULATION_PORTFOLIO: 'demo-500' | 'demo-5000';
  readonly RHEA_CONTRACT_ID: AccountId;
  readonly BURROW_CONTRACT_ID: AccountId;
  readonly BURROW_ORACLE_ID: AccountId;
  readonly MARKET_DATA: 'none' | 'mainnet-reference';
  readonly YIELD_DATA: 'none' | 'testnet-onchain';
  readonly RHEA_DCL_CONTRACT_ID: AccountId | undefined;
  readonly PYTH_API_KEY: string | undefined;
  readonly PYTH_HERMES_URL: string;
  readonly DEFILLAMA_URL: string;
}

export const apiEnvSchema = apiEnvRaw.superRefine((env, ctx) => {
  // Hard rule: this system never signs on mainnet. There is no override. Live signing is testnet-only.
  if (env.EXECUTION_MODE === 'live' && env.NEAR_NETWORK === 'mainnet') {
    ctx.addIssue({
      code: 'custom',
      path: ['EXECUTION_MODE'],
      message:
        'live execution is refused on mainnet (no mainnet signing keys, ever); use dry-run, or NEAR_NETWORK=testnet',
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
  if (env.MARKET_DATA === 'mainnet-reference') {
    const why =
      env.NEAR_NETWORK !== 'testnet'
        ? 'NEAR_NETWORK=testnet'
        : env.DATA_SOURCE !== 'chain'
          ? 'DATA_SOURCE=chain'
          : env.EXECUTION_MODE !== 'dry-run'
            ? 'EXECUTION_MODE=dry-run'
            : null;
    if (why)
      ctx.addIssue({
        code: 'custom',
        path: ['MARKET_DATA'],
        message: `mainnet reference prices are for testnet analysis only: requires ${why}`,
      });
  }
  if (env.YIELD_DATA === 'testnet-onchain' && env.MARKET_DATA !== 'mainnet-reference')
    // Implies testnet + chain + dry-run through the rule above; liquidity and pool checks need those prices.
    ctx.addIssue({
      code: 'custom',
      path: ['YIELD_DATA'],
      message:
        'testnet yield data requires MARKET_DATA=mainnet-reference (testnet, chain, dry-run)',
    });
  // Protocol contract ids differ per network; only mainnet has safe built-in defaults.
  if (env.NEAR_NETWORK === 'testnet') {
    for (const key of Object.keys(MAINNET_DEFAULTS) as Array<keyof typeof MAINNET_DEFAULTS>) {
      if (!env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'required when NEAR_NETWORK=testnet',
        });
    }
  }
});

export function loadApiEnv(source: EnvSource = process.env): ApiEnv {
  const env = parseEnv(apiEnvSchema, source);
  const mainnet = env.NEAR_NETWORK === 'mainnet';
  const pick = (key: keyof typeof MAINNET_DEFAULTS): AccountId => {
    const value = env[key] ?? (mainnet ? (MAINNET_DEFAULTS[key] as AccountId) : undefined);
    if (!value) throw new EnvValidationError([`${key}: required`]);
    return value;
  };
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
    CYCLE_INTERVAL_SECONDS: env.CYCLE_INTERVAL_SECONDS,
    AUTOPILOT_CONFIG_FILE: env.AUTOPILOT_CONFIG_FILE,
    AUTOPILOT_ENGINE: env.AUTOPILOT_ENGINE,
    DATA_SOURCE: env.DATA_SOURCE,
    SIMULATION_PORTFOLIO: env.SIMULATION_PORTFOLIO,
    RHEA_CONTRACT_ID: pick('RHEA_CONTRACT_ID'),
    BURROW_CONTRACT_ID: pick('BURROW_CONTRACT_ID'),
    BURROW_ORACLE_ID: pick('BURROW_ORACLE_ID'),
    MARKET_DATA: env.MARKET_DATA,
    YIELD_DATA: env.YIELD_DATA,
    RHEA_DCL_CONTRACT_ID: env.RHEA_DCL_CONTRACT_ID,
    PYTH_API_KEY: env.PYTH_API_KEY,
    PYTH_HERMES_URL: env.PYTH_HERMES_URL,
    DEFILLAMA_URL: env.DEFILLAMA_URL,
  };
}

export const dashboardEnvSchema = z.object({
  /** Base URL of the API, reachable from the dashboard's server (not the browser). */
  API_BASE_URL: z.string().url(),
  API_TOKEN: z.string().min(32, 'must be at least 32 characters'),
});
export type DashboardEnv = z.output<typeof dashboardEnvSchema>;

export function loadDashboardEnv(source: EnvSource = process.env): DashboardEnv {
  return parseEnv(dashboardEnvSchema, source);
}

export const databaseEnvSchema = z.object({ DATABASE_URL: z.string().url() });
export type DatabaseEnv = z.output<typeof databaseEnvSchema>;

export function loadDatabaseEnv(source: EnvSource = process.env): DatabaseEnv {
  return parseEnv(databaseEnvSchema, source);
}
