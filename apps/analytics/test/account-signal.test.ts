import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAccountSignal } from '../lib/account-signal';

function stubChain(state: { nonces: (number | string)[]; amount: string } | 'down') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      if (state === 'down') throw new Error('offline');
      const { params } = JSON.parse(init.body) as { params: { request_type: string } };
      const result =
        params.request_type === 'view_account'
          ? { amount: state.amount }
          : { keys: state.nonces.map((nonce) => ({ access_key: { nonce } })) };
      return new Response(JSON.stringify({ result }));
    }),
  );
}

describe('readAccountSignal', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('changes on an incoming transfer that leaves the nonces alone', async () => {
    stubChain({ nonces: [5, 9], amount: '1000' });
    const before = await readAccountSignal('alice.near');
    stubChain({ nonces: [5, 9], amount: '3000' });
    expect(await readAccountSignal('alice.near')).not.toBe(before);
  });

  it('changes on an own transaction, including a relayed one that keeps the balance', async () => {
    stubChain({ nonces: [9], amount: '1000' });
    const before = await readAccountSignal('alice.near');
    stubChain({ nonces: ['10'], amount: '1000' });
    expect(await readAccountSignal('alice.near')).not.toBe(before);
  });

  it('is stable while nothing lands and null when the RPC is unreachable', async () => {
    stubChain({ nonces: [9], amount: '1000' });
    expect(await readAccountSignal('alice.near')).toBe(await readAccountSignal('alice.near'));
    stubChain('down');
    expect(await readAccountSignal('alice.near')).toBeNull();
  });
});
