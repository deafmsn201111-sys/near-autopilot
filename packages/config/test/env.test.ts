import { describe, expect, it } from 'vitest';
import {
  EnvValidationError,
  llmEnvSchema,
  loadApiEnv,
  loadDashboardEnv,
  oneClickEnvSchema,
  shieldEnvSchema,
} from '../src';

const valid = {
  API_TOKEN: 'x'.repeat(32),
  DATABASE_URL: 'postgres://user:pw@localhost:5432/autopilot',
  NEAR_NETWORK: 'mainnet',
  NEAR_RPC_URL: 'https://rpc.mainnet.near.org',
  AUTOPILOT_ACCOUNT_ID: 'alice.near',
};

describe('loadApiEnv', () => {
  it('applies safe defaults: dry-run, scheduler off, mainnet contract ids', () => {
    const env = loadApiEnv(valid);
    expect(env.EXECUTION_MODE).toBe('dry-run');
    expect(env.API_PORT).toBe(4000);
    expect(env.RHEA_CONTRACT_ID).toBe('v2.ref-finance.near');
    expect(env.BURROW_ORACLE_ID).toBe('priceoracle.near');
  });

  it('coerces numbers and honours overrides', () => {
    const env = loadApiEnv({
      ...valid,
      API_PORT: '8080',
      BURROW_CONTRACT_ID: 'burrow.example.near',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.BURROW_CONTRACT_ID).toBe('burrow.example.near');
  });

  it('refuses live execution, with no override', () => {
    expect(() => loadApiEnv({ ...valid, EXECUTION_MODE: 'live' })).toThrow(
      'live execution is refused on mainnet',
    );
    expect(loadApiEnv({ ...valid, EXECUTION_MODE: 'dry-run' }).EXECUTION_MODE).toBe('dry-run');
  });

  it('orchestrator engine and simulation are dry-run only', () => {
    const live = { ...valid, EXECUTION_MODE: 'live' };
    expect(() => loadApiEnv({ ...live, AUTOPILOT_ENGINE: 'orchestrator' })).toThrow('dry-run only');
    expect(() => loadApiEnv({ ...live, DATA_SOURCE: 'simulation' })).toThrow(
      'simulation never executes',
    );
    const sim = loadApiEnv({
      ...valid,
      DATA_SOURCE: 'simulation',
      SIMULATION_PORTFOLIO: 'demo-5000',
    });
    expect(sim).toMatchObject({
      DATA_SOURCE: 'simulation',
      SIMULATION_PORTFOLIO: 'demo-5000',
      AUTOPILOT_ENGINE: 'legacy',
      EXECUTION_MODE: 'dry-run',
    });
  });

  it('is mainnet only: testnet networks and testnet data modes are rejected', () => {
    for (const [key, value] of [
      ['NEAR_NETWORK', 'testnet'],
      ['MARKET_DATA', 'mainnet-reference'],
      ['YIELD_DATA', 'testnet-onchain'],
    ] as const) {
      expect(() => loadApiEnv({ ...valid, [key]: value })).toThrow(`${key}: Invalid`);
    }
    expect(loadApiEnv(valid)).toMatchObject({ MARKET_DATA: 'none', YIELD_DATA: 'none' });
  });

  it('never echoes the Pyth key', () => {
    expect(loadApiEnv({ ...valid, PYTH_API_KEY: '' }).PYTH_API_KEY).toBeUndefined();
    expect(() => loadApiEnv({ ...valid, PYTH_API_KEY: 'short', API_TOKEN: 'x' })).toThrow(
      /^(?!.*short)/s,
    );
  });

  it('treats empty contract ids as unset (compose passes ${VAR:-})', () => {
    const empty = { RHEA_CONTRACT_ID: '', BURROW_CONTRACT_ID: '', BURROW_ORACLE_ID: '' };
    expect(loadApiEnv({ ...valid, ...empty }).BURROW_CONTRACT_ID).toBe('contract.main.burrow.near');
    expect(loadApiEnv({ ...valid, RHEA_DCL_CONTRACT_ID: '' }).RHEA_DCL_CONTRACT_ID).toBeUndefined();
  });

  it('reports every problem and never echoes secret values', () => {
    try {
      loadApiEnv({
        ...valid,
        API_TOKEN: 'short-secret',
        NEAR_RPC_URL: 'not a url',
        AUTOPILOT_ACCOUNT_ID: 'BAD ID',
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain('API_TOKEN');
      expect(message).toContain('NEAR_RPC_URL');
      expect(message).toContain('AUTOPILOT_ACCOUNT_ID');
      expect(message).not.toContain('short-secret');
    }
  });
});

describe('loadDashboardEnv', () => {
  it('validates the API location and token', () => {
    expect(
      loadDashboardEnv({ API_BASE_URL: 'http://api:4000', API_TOKEN: 'y'.repeat(40) }).API_BASE_URL,
    ).toBe('http://api:4000');
    expect(() => loadDashboardEnv({ API_BASE_URL: 'nope', API_TOKEN: 'short' })).toThrow(
      EnvValidationError,
    );
  });
});

describe('llmEnvSchema', () => {
  it('is off without a key; empty or unset model and max_tokens default to Haiku and 4096', () => {
    expect(
      llmEnvSchema.parse({ ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: '', ANTHROPIC_MAX_TOKENS: '' }),
    ).toEqual({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: 'claude-haiku-5-5',
      ANTHROPIC_MAX_TOKENS: 4096,
      LLM_DAILY_CAP_USD: 5,
    });
  });

  it('accepts only the allowlisted models', () => {
    const bad = llmEnvSchema.safeParse({ ANTHROPIC_MODEL: 'claude-made-up' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/claude-haiku-5-5.*claude-sonnet-5-5/);
  });

  it('takes a daily cap in USD and rejects a negative one', () => {
    expect(llmEnvSchema.parse({ LLM_DAILY_CAP_USD: '0.01' }).LLM_DAILY_CAP_USD).toBe(0.01);
    expect(llmEnvSchema.safeParse({ LLM_DAILY_CAP_USD: '-1' }).success).toBe(false);
  });

  it('honours overrides and rejects a zero cap', () => {
    expect(
      llmEnvSchema.parse({
        ANTHROPIC_API_KEY: 'sk-test-key',
        ANTHROPIC_MODEL: 'claude-sonnet-5-5',
        ANTHROPIC_MAX_TOKENS: '2000',
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: 'sk-test-key',
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_MAX_TOKENS: 2000,
      LLM_DAILY_CAP_USD: 5,
    });
    expect(llmEnvSchema.safeParse({ ANTHROPIC_MAX_TOKENS: '0' }).success).toBe(false);
  });
});

describe('oneClickEnvSchema', () => {
  it('treats unset and empty ONE_CLICK_JWT as no JWT', () => {
    expect(oneClickEnvSchema.parse({}).ONE_CLICK_JWT).toBeUndefined();
    expect(oneClickEnvSchema.parse({ ONE_CLICK_JWT: '' }).ONE_CLICK_JWT).toBeUndefined();
  });

  it('takes a JWT and refuses anything that could break the header', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    expect(oneClickEnvSchema.parse({ ONE_CLICK_JWT: jwt }).ONE_CLICK_JWT).toBe(jwt);
    for (const bad of ['short', `${jwt}\r\nx-evil: 1`, `${jwt} `])
      expect(oneClickEnvSchema.safeParse({ ONE_CLICK_JWT: bad }).success).toBe(false);
  });

  it('reads Solana mints from the public mainnet RPC unless an https URL is set', () => {
    expect(oneClickEnvSchema.parse({ SOLANA_RPC_URL: '' }).SOLANA_RPC_URL).toBe(
      'https://api.mainnet-beta.solana.com',
    );
    const own = 'https://solana.example.org/rpc';
    expect(oneClickEnvSchema.parse({ SOLANA_RPC_URL: own }).SOLANA_RPC_URL).toBe(own);
    expect(oneClickEnvSchema.safeParse({ SOLANA_RPC_URL: 'http://x.example' }).success).toBe(false);
  });
});

describe('shieldEnvSchema', () => {
  it('treats unset and empty SHIELD_JWT as the feature off', () => {
    expect(shieldEnvSchema.parse({})).toEqual({});
    expect(shieldEnvSchema.parse({ SHIELD_JWT: '', SHIELD_URL: '' })).toEqual({});
  });

  it('takes a key and refuses anything that could break the header', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    expect(shieldEnvSchema.parse({ SHIELD_JWT: jwt }).SHIELD_JWT).toBe(jwt);
    for (const bad of ['short', `${jwt}\r\nx-evil: 1`, `${jwt} `])
      expect(shieldEnvSchema.safeParse({ SHIELD_JWT: bad }).success).toBe(false);
  });
});
