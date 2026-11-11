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
    expect(config.rhea.pools.map((p) => p.poolId)).toEqual([4512]);
    expect(config.yield?.rheaV1Pools).toContain(4512);
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
