import { describe, expect, it, vi } from 'vitest';
import { progressFooter, stepAfterCheck } from '../lib/sign-progress';

const sent: string[] = [];
vi.mock('../lib/wallet', () => ({
  currentAccount: async () => 'alice.near',
  connectedWallet: async () => ({
    signAndSendTransaction: async ({ receiverId }: { receiverId: string }) => {
      sent.push(receiverId);
      return { transaction_outcome: { id: `hash-${receiverId}` } };
    },
  }),
}));

const tx = (receiverId: string) => ({
  intentId: receiverId,
  receiverId,
  actions: [{ methodName: 'ft_transfer_call', args: {}, gas: '1', deposit: '1' }],
});

describe('signCascade with a server check after each step', () => {
  it('does not offer the next step after one that did not complete', async () => {
    const { signCascade } = await import('../lib/wallet-sign');
    const r = await signCascade([tx('a.near'), tx('b.near')], 'alice.near', true, {
      onSent: async () => false,
    });
    expect(sent).toEqual(['a.near']);
    expect(r).toMatchObject({ ok: false, hashes: ['hash-a.near'] });
  });
});

describe('progressFooter', () => {
  const done = stepAfterCheck('h', { status: 'confirmed', lines: [] });
  const failed = stepAfterCheck('h', {
    status: 'failed',
    lines: [],
    failure: { contract: 'c', error: 'e' },
    funds: 'No funds left your wallet.',
  });

  it('says done only when every step is confirmed', () => {
    expect(progressFooter([done, done], false)).toBe('Done. Every step is confirmed on NEAR.');
    expect(progressFooter([done, { kind: 'waiting' }], false)).toBe('');
  });

  it('says the next step was not offered after a failure', () => {
    expect(progressFooter([failed, { kind: 'waiting' }], false)).toMatch(/not offered/);
  });

  it('says not signed when the wallet declined', () => {
    expect(progressFooter([{ kind: 'stopped', reason: 'declined' }], false)).toMatch(/Not signed/);
  });
});
