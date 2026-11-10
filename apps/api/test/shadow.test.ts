import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiEnv, type ApiEnv } from '@near-autopilot/config';
import { accountId, NetworkMismatchError } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { parseMarketConfig } from '../src/market-config';
import { wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

/**
 * MAINNET READ-ONLY SHADOW ANALYSIS, offline: a simulated demo portfolio (in-process mock RPC) with mainnet prices,
 * yields and quotes from FAKE mainnet transports. Proves the wiring only ever issues read methods to "mainnet" and
 * never builds a signer or sends anything.
 */
const ACCOUNT = 'shadow-demo.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const config = parseMarketConfig(
  JSON.parse(
    readFileSync(new URL('../../../config/market.json', import.meta.url), 'utf8'),
  ) as unknown,
  accountId(ACCOUNT),
);

const envFor = (over: Record<string, string> = {}): ApiEnv =>
  loadApiEnv({
    API_TOKEN: 'test-token-test-token-test-token-test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTOPILOT_ACCOUNT_ID: ACCOUNT,
    NEAR_NETWORK: 'mainnet',
    NEAR_RPC_URL: 'https://rpc.must-not-be-contacted.invalid',
    DATA_SOURCE: 'simulation',
    AUTOPILOT_ENGINE: 'orchestrator',
    MARKET_DATA: 'mainnet-live',
    YIELD_DATA: 'mainnet-onchain',
    RHEA_DCL_CONTRACT_ID: 'dclv2.ref-labs.near',
    MAINNET_READ_RPC_URL: 'https://mainnet-read.invalid',
    // A (fake) key: this suite is about read-only behaviour, not keyless throttling (one request at a time, slower
    // retries), which would only make its deliberately failing calls slow.
    MAINNET_READ_RPC_API_KEY: 'test-key-not-sent-anywhere',
    ...over,
  });

const bytes = (v: unknown) => ({ result: [...Buffer.from(JSON.stringify(v), 'utf8')] });
const asset = (token: string, xdec: number, supplied: string, borrowed: string, apr: string) => ({
  token_id: token,
  supplied: { shares: supplied, balance: supplied },
  borrowed: { shares: borrowed, balance: borrowed },
  reserved: '0',
  config: {
    reserve_ratio: 2500,
    target_utilization: 8000,
    volatility_ratio: 9500,
    extra_decimals: xdec,
    can_deposit: true,
    can_withdraw: true,
    can_use_as_collateral: true,
    can_borrow: true,
  },
  supply_apr: apr,
  borrow_apr: '0.15',
  last_update_timestamp: '1793900000000000000',
  farms: [],
});

/** Fake MAINNET RPC: answers status/block/views, records every JSON-RPC method it receives. */
function fakeMainnet(chainId = 'mainnet') {
  const methods: string[] = [];
  const impl: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
    const body = JSON.parse(init.body) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    methods.push(body.method);
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    if (body.method === 'status') return ok({ chain_id: chainId });
    if (body.method === 'block')
      return ok({ header: { height: 9_000, timestamp_nanosec: `${Date.now()}000000` } });
    if (body.method !== 'query') return new Response('nope', { status: 400 });
    const p = body.params as { account_id: string; method_name: string; args_base64: string };
    const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString()) as Record<
      string,
      unknown
    >;
    if (p.method_name === 'ft_metadata') {
      const d = p.account_id === 'wrap.near' ? 24 : 6;
      return ok(bytes({ spec: 'ft-1.0.0', name: p.account_id, symbol: 'T', decimals: d }));
    }
    if (p.account_id === 'contract.main.burrow.near') {
      if ((args.from_index as number) > 0) return ok(bytes([]));
      return ok(
        bytes([
          asset('wrap.near', 0, (1_000_000n * 10n ** 24n).toString(), '0', '0.0033'),
          asset(
            'usdt.tether-token.near',
            12,
            (10_000_000n * 10n ** 18n).toString(),
            (5_000_000n * 10n ** 18n).toString(),
            '0.1118',
          ),
          asset(
            USDC,
            12,
            (10_000_000n * 10n ** 18n).toString(),
            (5_000_000n * 10n ** 18n).toString(),
            '0.1199',
          ),
        ]),
      );
    }
    // Rhea v1 / DCL / get_return are not served: those sources must then be reported unavailable, not invented.
    return new Response('not served', { status: 500 });
  };
  return { impl, methods };
}

const nowS = () => Math.floor(Date.now() / 1000);
const llama: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/prices/current/'))
    return new Response(
      JSON.stringify({
        coins: {
          'coingecko:near': {
            price: 4.0,
            symbol: 'NEAR',
            timestamp: nowS() - 10,
            confidence: 0.999,
          },
          'coingecko:tether': {
            price: 0.999,
            symbol: 'USDT',
            timestamp: nowS() - 10,
            confidence: 0.999,
          },
          'coingecko:usd-coin': {
            price: 1.0,
            symbol: 'USDC',
            timestamp: nowS() - 10,
            confidence: 0.999,
          },
        },
      }),
      { status: 200 },
    );
  return new Response(JSON.stringify({ coins: {} }), { status: 200 });
};

describe('mainnet read-only shadow analysis', () => {
  it('config: only for a simulated portfolio on mainnet in dry-run, with a read-only mainnet RPC', () => {
    expect(() => envFor({ DATA_SOURCE: 'chain' })).toThrow('DATA_SOURCE=simulation');
    expect(() => envFor({ EXECUTION_MODE: 'live' })).toThrow();
    expect(() => envFor({ MAINNET_READ_RPC_URL: '' })).toThrow('MAINNET_READ_RPC_URL');
    expect(() => envFor({ MARKET_DATA: 'none' })).toThrow('YIELD_DATA');
    expect(envFor().MARKET_DATA).toBe('mainnet-live');
  });

  it('refuses to start when the "mainnet" read RPC serves another chain', async () => {
    const m = fakeMainnet('localnet');
    await expect(
      wire(envFor(), config, new InMemoryRepository(), new SilentLogger(), {
        mainnetFetchImpl: m.impl,
        marketFetchImpl: llama,
      }),
    ).rejects.toBeInstanceOf(NetworkMismatchError);
  });

  it('runs a full orchestrator cycle on real-shaped mainnet data and only ever READS mainnet', async () => {
    const m = fakeMainnet();
    const repo = new InMemoryRepository({ dataSource: 'simulation', network: 'mainnet' });
    const wired = await wire(envFor(), config, repo, new SilentLogger(), {
      mainnetFetchImpl: m.impl,
      marketFetchImpl: llama,
    });
    const result = await wired.cycle.run();
    expect(result.run.status).toBe('completed');

    // Read methods only; no broadcast of any kind ever reached the mainnet transport.
    expect(new Set(m.methods)).toEqual(new Set(['status', 'block', 'query']));

    const report = await wired.yields?.report();
    expect(report?.network).toBe('mainnet');
    const supply = (t: string) =>
      report?.estimates.find((e) => e.marketId === t && e.yieldType === 'lending_supply');
    expect(supply('usdt.tether-token.near')?.validationStatus).toBe('valid');
    expect(supply(USDC)?.validationStatus).toBe('valid');
    expect(report?.sources.find((s) => s.source === 'rhea_v1')?.health).toBe('unavailable');
    const market = await wired.market?.report();
    expect(market?.executionNetwork).toBe('none');
    // Nothing executed: every proposal is a dry run without a transaction hash.
    for (const p of await repo.listProposals({ limit: 50 })) {
      expect(p.txHash).toBeNull();
      expect(p.executionMode).toBe('dry-run');
    }
  });
});
