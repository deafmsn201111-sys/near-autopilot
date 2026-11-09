import { describe, expect, it } from 'vitest';
import { accountId, type FunctionCallAction } from '@near-autopilot/core';
import { assembleCascade, formatNear, type CascadeStep } from '../src/wallet/cascade';

const action = (methodName: string): FunctionCallAction => ({
  type: 'FunctionCall',
  methodName,
  args: {},
  gas: 1n,
  deposit: 1n,
});

describe('assembleCascade', () => {
  const signer = accountId('alice.near');
  const register: CascadeStep = {
    intentId: 'register',
    tx: {
      receiverId: accountId('contract.main.burrow.near'),
      actions: [action('storage_deposit')],
    },
    preview: 'Register on Burrow (one-time).',
  };
  const supply: CascadeStep = {
    intentId: 'supply',
    tx: { receiverId: accountId('usdt.tether-token.near'), actions: [action('ft_transfer_call')] },
    preview: 'Supply 100 USDt to Burrow.',
  };

  it('keeps the given order, stamps the signer on every tx, and mirrors the preview', () => {
    const c = assembleCascade(signer, [register, supply]);
    expect(c.transactions.map((t) => [t.intentId, t.signerId, t.receiverId])).toEqual([
      ['register', 'alice.near', 'contract.main.burrow.near'],
      ['supply', 'alice.near', 'usdt.tether-token.near'],
    ]);
    expect(c.transactions[0]?.actions[0]?.methodName).toBe('storage_deposit');
    expect(c.preview).toEqual(['Register on Burrow (one-time).', 'Supply 100 USDt to Burrow.']);
  });

  it('works for a single-step cascade (already registered)', () => {
    const c = assembleCascade(signer, [supply]);
    expect(c.transactions).toHaveLength(1);
    expect(c.transactions[0]?.intentId).toBe('supply');
  });

  it('refuses an empty cascade', () => {
    expect(() => assembleCascade(signer, [])).toThrow();
  });
});

describe('formatNear', () => {
  it('formats yoctoNEAR to a short NEAR string', () => {
    expect(formatNear(10n ** 24n)).toBe('1');
    expect(formatNear(250_000_000_000_000_000_000_000n)).toBe('0.25');
    expect(formatNear(1_500_000_000_000_000_000_000_000n)).toBe('1.5');
  });
});
