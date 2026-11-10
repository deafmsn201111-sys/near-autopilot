import { accountId } from '@near-autopilot/core';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { describe, expect, it } from 'vitest';
import { YieldService } from '../src/yield/service';

/**
 * READ-ONLY live check against NEAR MAINNET (view calls only; nothing is signed or sent). Skipped unless YIELD_LIVE=1:
 *   YIELD_LIVE=1 pnpm --filter @near-autopilot/api test:live:yield
 * Uses MAINNET_READ_RPC_URL (+ MAINNET_READ_RPC_API_KEY as a Bearer header) from the local .env, else the public
 * endpoint.
 * No prices are supplied on purpose: every estimate must then be rejected with MISSING_PRICE, never valued.
 */
const live = process.env.YIELD_LIVE === '1';
const url = process.env.MAINNET_READ_RPC_URL || 'https://rpc.mainnet.near.org';
const key = process.env.MAINNET_READ_RPC_API_KEY;

describe.skipIf(!live)('mainnet yield sources (live, read-only)', () => {
  it('reads Burrow, Rhea v1 and Rhea DCL at one final block', async () => {
    const rpc = new NearRpcClient({
      url,
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
      maxConcurrent: 2,
    });
    const status = (await rpc.call('status', [])) as { chain_id: string };
    expect(status.chain_id).toBe('mainnet');
    const r = await new YieldService({
      rpc,
      burrowContract: accountId('contract.main.burrow.near'),
      rheaContract: accountId('v2.ref-finance.near'),
      dclContract: accountId('dclv2.ref-labs.near'),
      rheaV1Pools: [4512, 3879],
      dclPools: ['17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|2000'],
      allowlist: new Set(),
      allowedTokens: new Set([
        'wrap.near',
        'usdt.tether-token.near',
        '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      ]),
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
      'pool:4512',
      'pool:3879',
    ]);
    for (const e of r.estimates.filter((x) => x.source !== 'burrow'))
      expect(e.reasons.map((x) => x.code)).toContain('UNVERIFIED_POOL');
  }, 120_000);
});
