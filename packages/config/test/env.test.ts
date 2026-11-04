import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadApiEnv, loadDashboardEnv } from '../src';

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
    expect(env.CYCLE_INTERVAL_SECONDS).toBe(0);
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

  it('refuses live execution on mainnet, with no override, but allows it on testnet', () => {
    expect(() => loadApiEnv({ ...valid, EXECUTION_MODE: 'live' })).toThrow(
      'live execution is refused on mainnet',
    );
    const testnet = {
      ...valid,
      NEAR_NETWORK: 'testnet',
      EXECUTION_MODE: 'live',
      RHEA_CONTRACT_ID: 'ref-finance-101.testnet',
      BURROW_CONTRACT_ID: 'contract.1638481328.burrow.testnet',
      BURROW_ORACLE_ID: 'priceoracle.testnet',
    };
    expect(loadApiEnv(testnet).EXECUTION_MODE).toBe('live');
    expect(loadApiEnv({ ...valid, EXECUTION_MODE: 'dry-run' }).EXECUTION_MODE).toBe('dry-run');
  });

  it('orchestrator engine and simulation are dry-run only', () => {
    const testnetLive = {
      ...valid,
      NEAR_NETWORK: 'testnet',
      EXECUTION_MODE: 'live',
      RHEA_CONTRACT_ID: 'ref-finance-101.testnet',
      BURROW_CONTRACT_ID: 'contract.1638481328.burrow.testnet',
      BURROW_ORACLE_ID: 'priceoracle.testnet',
    };
    expect(() => loadApiEnv({ ...testnetLive, AUTOPILOT_ENGINE: 'orchestrator' })).toThrow(
      'dry-run only',
    );
    expect(() => loadApiEnv({ ...testnetLive, DATA_SOURCE: 'simulation' })).toThrow(
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

  it('mainnet reference market data is for testnet chain dry-run only, and the Pyth key is never echoed', () => {
    const testnet = {
      ...valid,
      NEAR_NETWORK: 'testnet',
      NEAR_RPC_URL: 'https://rpc.testnet.near.org',
      AUTOPILOT_ACCOUNT_ID: 'alice.testnet',
      RHEA_CONTRACT_ID: 'ref.testnet',
      BURROW_CONTRACT_ID: 'burrow.testnet',
      BURROW_ORACLE_ID: 'oracle.testnet',
      MARKET_DATA: 'mainnet-reference',
    };
    const ok = loadApiEnv({ ...testnet, PYTH_API_KEY: '' });
    expect(ok.MARKET_DATA).toBe('mainnet-reference');
    expect(ok.PYTH_API_KEY).toBeUndefined();
    expect(loadApiEnv(valid).MARKET_DATA).toBe('none');
    for (const [over, needs] of [
      [
        { NEAR_NETWORK: 'mainnet', NEAR_RPC_URL: 'https://rpc.mainnet.near.org' },
        'NEAR_NETWORK=testnet',
      ],
      [{ DATA_SOURCE: 'simulation' }, 'DATA_SOURCE=chain'],
      [{ EXECUTION_MODE: 'live' }, 'EXECUTION_MODE=dry-run'],
    ] as const) {
      expect(() => loadApiEnv({ ...testnet, ...over })).toThrow(needs);
    }
    try {
      loadApiEnv({ ...testnet, PYTH_API_KEY: 'short', API_TOKEN: 'x' });
    } catch (e) {
      expect(String(e)).not.toContain('short');
    }
  });

  it('testnet yield data needs mainnet reference prices (hence testnet, chain, dry-run)', () => {
    const testnet = {
      ...valid,
      NEAR_NETWORK: 'testnet',
      NEAR_RPC_URL: 'https://rpc.testnet.near.org',
      AUTOPILOT_ACCOUNT_ID: 'alice.testnet',
      RHEA_CONTRACT_ID: 'ref.testnet',
      BURROW_CONTRACT_ID: 'burrow.testnet',
      BURROW_ORACLE_ID: 'oracle.testnet',
      YIELD_DATA: 'testnet-onchain',
    };
    expect(() => loadApiEnv(testnet)).toThrow('YIELD_DATA');
    const ok = loadApiEnv({
      ...testnet,
      MARKET_DATA: 'mainnet-reference',
      RHEA_DCL_CONTRACT_ID: '',
    });
    expect(ok.YIELD_DATA).toBe('testnet-onchain');
    expect(ok.RHEA_DCL_CONTRACT_ID).toBeUndefined();
    expect(() =>
      loadApiEnv({ ...testnet, MARKET_DATA: 'mainnet-reference', EXECUTION_MODE: 'live' }),
    ).toThrow('EXECUTION_MODE=dry-run');
    expect(loadApiEnv(valid).YIELD_DATA).toBe('none');
  });

  it('treats empty contract ids as unset (compose passes ${VAR:-})', () => {
    const empty = { RHEA_CONTRACT_ID: '', BURROW_CONTRACT_ID: '', BURROW_ORACLE_ID: '' };
    expect(loadApiEnv({ ...valid, ...empty }).BURROW_CONTRACT_ID).toBe('contract.main.burrow.near');
    expect(() => loadApiEnv({ ...valid, ...empty, NEAR_NETWORK: 'testnet' })).toThrow(
      'required when NEAR_NETWORK=testnet',
    );
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

  it('requires explicit contract ids on testnet', () => {
    expect(() => loadApiEnv({ ...valid, NEAR_NETWORK: 'testnet' })).toThrow(
      'required when NEAR_NETWORK=testnet',
    );
    const env = loadApiEnv({
      ...valid,
      NEAR_NETWORK: 'testnet',
      RHEA_CONTRACT_ID: 'ref-finance-101.testnet',
      BURROW_CONTRACT_ID: 'contract.1638481328.burrow.testnet',
      BURROW_ORACLE_ID: 'priceoracle.testnet',
    });
    expect(env.RHEA_CONTRACT_ID).toBe('ref-finance-101.testnet');
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
