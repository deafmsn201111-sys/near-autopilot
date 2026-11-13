import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAccount, watchStep, type Reading } from '../lib/account-signal';

const NEAR = 10n ** 24n;
const at = (height: number, near: number): Reading => ({
  height,
  amount: String((BigInt(Math.round(near * 1e6)) * NEAR) / 1_000_000n),
});

function run(readings: (Reading | null)[], quietAt: number[] = []) {
  let last: Reading | null = null;
  return readings.map((r, i) => {
    const step = watchStep(last, r, quietAt.includes(i));
    last = step.last;
    return step.fire;
  });
}

describe('watchStep', () => {
  it('fires once when a transfer lands, never on the first reading', () => {
    expect(run([at(1, 5), at(2, 5), at(3, 8), at(4, 8)])).toEqual([false, false, true, false]);
  });

  it('drops readings from an older or the same block', () => {
    expect(run([at(10, 5), at(9, 4), at(10, 4), at(11, 5)])).toEqual([false, false, false, false]);
  });

  it('ignores a move below 4 significant digits: gas refund, dust, contract gas rewards', () => {
    expect(run([at(1, 12.34), at(2, 12.3412), at(3, 12.3399)])).toEqual([false, false, false]);
  });

  it('stays quiet while a refresh runs or just ended, and keeps the new baseline', () => {
    expect(run([at(1, 5), at(2, 4), at(3, 4), at(4, 9)], [1])).toEqual([false, false, false, true]);
  });

  it('skips a failed read without losing the baseline', () => {
    expect(run([at(1, 5), null, at(3, 6)])).toEqual([false, false, true]);
  });
});

describe('readAccount', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (res: Response | Error) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (res instanceof Error) throw res;
        return res;
      }),
    );

  it('reads the balance and its block', async () => {
    stub(new Response(JSON.stringify({ result: { amount: '2038', block_height: 224 } })));
    expect(await readAccount('alice.near')).toEqual({ height: 224, amount: '2038' });
  });

  it('is null on an RPC error, an HTTP error or no network', async () => {
    stub(new Response(JSON.stringify({ error: { name: 'UNKNOWN_ACCOUNT' } })));
    expect(await readAccount('alice.near')).toBeNull();
    stub(new Response('slow down', { status: 429 }));
    expect(await readAccount('alice.near')).toBeNull();
    stub(new Error('offline'));
    expect(await readAccount('alice.near')).toBeNull();
  });
});
