import { accountId } from '@near-autopilot/core';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { describe, expect, it } from 'vitest';
import { YieldService } from '../src/yield/service';

/**
 * READ-ONLY live check against NEAR TESTNET (view calls only; nothing is signed or sent). Skipped unless YIELD_LIVE=1:
 *   YIELD_LIVE=1 pnpm --filter @near-autopilot/api test:live:yield
 * Uses TESTNET_RPC_URL (+ TESTNET_RPC_API_KEY as a Bearer header) from the local .env, else the public endpoint.
 * No prices are supplied on purpose: every estimate must then be rejected with MISSING_PRICE, never valued.
 */
const live = process.env.YIELD_LIVE === '1';
const url = process.env.TESTNET_RPC_URL || 'https://rpc.testnet.near.org';
const key = process.env.TESTNET_RPC_API_KEY;

describe.skipIf(!live)('testnet yield sources (live, read-only)', () => {
  it('reads Burrow, Rhea v1 and Rhea DCL at one final testnet block', async () => {
    const rpc = new NearRpcClient({
      url,
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
      maxConcurrent: 2,
    });
    const status = (await rpc.call('status', [])) as { chain_id: string };
    expect(status.chain_id).toBe('testnet');
    const r = await new YieldService({
      rpc,
      burrowContract: accountId('contract.1638481328.burrow.testnet'),
      rheaContract: accountId('ref-finance-101.testnet'),
      dclContract: accountId('dclv2.ref-dev.testnet'),
      rheaV1Pools: [34, 54],
      dclPools: ['usdt.fakes.testnet|wrap.testnet|2000'],
      allowlist: new Set(),
      allowedTokens: new Set(['wrap.testnet', 'usdt.fakes.testnet', 'usdc.fakes.testnet']),
      prices: async () => () => null,
      history: null,
      limits: {
        maxAprBps: 10_000,
        maxUtilizationBps: 9_500,
        minLiquidityUsd: 1_000,
        maxAgeSeconds: 300,
      },
      maxPriceDeviationBps: 150,
      minPeriodSeconds: 3_600,
      maxPeriodSeconds: 604_800,
      now: () => new Date(),
      ids: () => 'live',
    }).report();

    // Report the real state, whatever it is, so a failure says which source and why.
    const sources = r.sources.map(
      (s) => `${s.source}:${s.health}:${s.marketsRead}${s.detail ? ` (${s.detail})` : ''}`,
    );
    console.log(`block ${r.block?.height}`, sources);
    for (const e of r.estimates)
      console.log(
        e.source,
        e.marketId,
        e.yieldType,
        e.apr ? `apr=${e.apr.mantissa}e${e.apr.exponent}` : 'apr=null',
        e.validationStatus,
        e.reasons.map((x) => x.code).join(','),
      );

    expect(r.block).not.toBeNull();
    expect(r.sources.map((s) => [s.source, s.health])).toEqual([
      ['burrow', 'ok'],
      ['rhea_v1', 'ok'],
      ['rhea_dcl', 'ok'],
    ]);
    expect(new Set(r.estimates.map((e) => e.block.height))).toEqual(new Set([r.block?.height]));
    const supply = r.estimates.filter(
      (e) => e.source === 'burrow' && e.yieldType === 'lending_supply',
    );
    expect(supply.length).toBeGreaterThan(0);
    // Without prices nothing may be strategic, and every supply estimate says why.
    expect(r.estimates.some((e) => e.validationStatus === 'valid')).toBe(false);
    for (const e of supply) expect(e.reasons.map((x) => x.code)).toContain('MISSING_PRICE');
    expect(r.estimates.filter((e) => e.source === 'rhea_v1').map((e) => e.marketId)).toEqual([
      'pool:34',
      'pool:54',
    ]);
    for (const e of r.estimates.filter((x) => x.source !== 'burrow'))
      expect(e.reasons.map((x) => x.code)).toContain('UNVERIFIED_POOL');
  }, 120_000);
});
