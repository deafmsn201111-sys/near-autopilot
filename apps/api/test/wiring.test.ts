import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiEnv, type ApiEnv } from '@near-autopilot/config';
import { accountId, NetworkMismatchError } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { parseMarketConfig } from '../src/market-config';
import { wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

const ACCOUNT = 'your-account.near';
const config = parseMarketConfig(
  JSON.parse(
    readFileSync(new URL('./fixtures/agents-config.json', import.meta.url), 'utf8'),
  ) as unknown,
  accountId(ACCOUNT),
);

const baseEnv = {
  API_TOKEN: 'test-token-test-token-test-token-test',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AUTOPILOT_ACCOUNT_ID: ACCOUNT,
};
const mainnetEnv = (): ApiEnv =>
  loadApiEnv({
    ...baseEnv,
    NEAR_NETWORK: 'mainnet',
    NEAR_RPC_URL: 'https://rpc.example.invalid',
  });
/** Fake RPC transport that answers `status` with the given chain id and records every method called. */
function rpcReporting(chainId: string) {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
    const body = JSON.parse(init.body) as { id: number; method: string };
    methods.push(body.method);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: chainId } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, methods };
}

const wireWith = (env: ApiEnv, chainId: string) => {
  const rpc = rpcReporting(chainId);
  const result = wire(env, config, new InMemoryRepository(), new SilentLogger(), {
    fetchImpl: rpc.fetchImpl,
  });
  return { result, methods: rpc.methods };
};

describe('wire (composition root)', () => {
  it('refuses live execution on mainnet before touching the network', async () => {
    const env: ApiEnv = { ...mainnetEnv(), EXECUTION_MODE: 'live' };
    const { result, methods } = wireWith(env, 'mainnet');
    await expect(result).rejects.toThrow('Refusing to wire live execution on mainnet');
    expect(methods).toEqual([]);
  });

  it('refuses to start when the RPC serves a different chain than NEAR_NETWORK', async () => {
    await expect(wireWith(mainnetEnv(), 'localnet').result).rejects.toBeInstanceOf(
      NetworkMismatchError,
    );
  });

  it('wires dry-run once the chain id matches', async () => {
    const { result, methods } = wireWith(mainnetEnv(), 'mainnet');
    const wired = await result;
    expect(wired.cycle).toBeDefined();
    expect(methods).toEqual(['status']);
  });

  it('sends NEAR_RPC_API_KEY as a Bearer header and no header without it', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
      const body = JSON.parse(init.body) as { id: number };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { chain_id: 'mainnet' } }),
        { status: 200 },
      );
    };
    const run = (env: ApiEnv) =>
      wire(env, config, new InMemoryRepository(), new SilentLogger(), { fetchImpl });
    await run({ ...mainnetEnv(), NEAR_RPC_API_KEY: 'k-test-1234567890' });
    await run(mainnetEnv());
    expect(seen).toEqual(['Bearer k-test-1234567890', null]);
  });
});
