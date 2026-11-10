import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accountId } from '@near-autopilot/core';
import { parseAutopilotConfig } from '../src/autopilot-config';

const example = JSON.parse(
  readFileSync(new URL('../../../config/autopilot.example.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('autopilot config', () => {
  it('the shipped example config is valid', () => {
    const config = parseAutopilotConfig(example, accountId('your-account.near'));
    expect(config.policy.allowedMethods).toEqual(['ft_transfer_call']);
    expect(config.rebalancer?.enabled).toBe(false);
    expect(config.rhea.pools).toEqual([]);
  });

  it('rejects a signer that differs from AUTOPILOT_ACCOUNT_ID', () => {
    expect(() => parseAutopilotConfig(example, accountId('someone-else.near'))).toThrow(
      'must equal AUTOPILOT_ACCOUNT_ID',
    );
  });

  it('rejects unknown keys and reports their paths', () => {
    expect(() =>
      parseAutopilotConfig({ ...example, surprise: 1 }, accountId('your-account.near')),
    ).toThrow('Invalid autopilot config');
  });
});
