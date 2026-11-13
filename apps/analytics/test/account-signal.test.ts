import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOLDOWN_MS, readAccount, watchStep, type WatchState } from '../lib/account-signal';

const start: WatchState = { last: null, firedAt: -Infinity };
const at = (height: number, amount: string) => ({ height, amount });

function run(readings: { r: ReturnType<typeof at> | null; t: number }[]) {
  let state = start;
  return readings.map(({ r, t }) => {
    const step = watchStep(state, r, t);
    state = step.state;
    return step.fire;
  });
}

describe('watchStep', () => {
  it('fires once when the balance changes, never on the first reading', () => {
    expect(
      run([
        { r: at(1, '1000'), t: 0 },
        { r: at(2, '1000'), t: 6_000 },
        { r: at(3, '3000'), t: 12_000 },
        { r: at(4, '3000'), t: 18_000 },
      ]),
    ).toEqual([false, false, true, false]);
  });

  it('drops readings from an older or the same block', () => {
    expect(
      run([
        { r: at(10, '1000'), t: 0 },
        { r: at(9, '900'), t: 6_000 },
        { r: at(10, '900'), t: 12_000 },
        { r: at(11, '1000'), t: 18_000 },
      ]),
    ).toEqual([false, false, false, false]);
  });

  it('a gas refund right after a transaction does not start a second refresh, a later transfer does', () => {
    expect(
      run([
        { r: at(1, '1000'), t: 0 },
        { r: at(2, '900'), t: 6_000 },
        { r: at(3, '910'), t: 12_000 },
        { r: at(4, '910'), t: 18_000 },
        { r: at(9, '5000'), t: 6_000 + COOLDOWN_MS },
      ]),
    ).toEqual([false, true, false, false, true]);
  });

  it('skips a failed read without losing the baseline', () => {
    expect(
      run([
        { r: at(1, '1000'), t: 0 },
        { r: null, t: 6_000 },
        { r: at(3, '2000'), t: 12_000 },
      ]),
    ).toEqual([false, false, true]);
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
