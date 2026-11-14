import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountId } from '@near-autopilot/core';
import { parseMarketConfig } from '../src/market-config';

const shipped = JSON.parse(
  readFileSync(new URL('../../../config/market.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const signer = accountId('shadow-demo.near');

describe('market config', () => {
  it('the shipped config/market.json is valid', () => {
    const config = parseMarketConfig(shipped, signer);
    expect(config.policy.allowedMethods).toEqual(['ft_transfer_call']);
    expect(config.policy.allowedTokens).toContain('wrap.near');
    expect(config.rhea.pools.map((p) => p.poolId)).toEqual([4512, 4179, 4179, 4179]);
    expect(config.yield?.rheaV1Pools).toContain(4512);
  });

  it('routes the stablecoins into each other through stable pool 4179 (D31, #191)', () => {
    const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
    const USDT = 'usdt.tether-token.near';
    const USDT_E = 'dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near';
    const pairs = parseMarketConfig(shipped, signer)
      .rhea.pools.filter((p) => p.poolId === 4179)
      .map((p) => [p.tokenA, p.tokenB].sort().join('|'));
    expect(pairs.sort()).toEqual(
      [
        [USDC, USDT],
        [USDC, USDT_E],
        [USDT, USDT_E],
      ]
        .map((p) => p.sort().join('|'))
        .sort(),
    );
  });

  it('rejects a signer that differs from AUTOPILOT_ACCOUNT_ID', () => {
    expect(() => parseMarketConfig(shipped, accountId('someone-else.near'))).toThrow(
      'must equal AUTOPILOT_ACCOUNT_ID',
    );
  });

  it('rejects unknown keys and reports their paths', () => {
    expect(() => parseMarketConfig({ ...shipped, surprise: 1 }, signer)).toThrow(
      'Invalid market config',
    );
  });
});
