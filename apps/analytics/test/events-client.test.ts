import { describe, expect, it } from 'vitest';
import { confirmStep } from '../lib/events-client';

const req = {
  account: 'alice.near',
  cascadeId: '6f9d2a52-3c3e-4c39-9d43-2f1f0b6c1a11',
  step: 0,
  hash: '4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR',
};

function answers(...list: { status: number; body: unknown }[]) {
  let i = 0;
  const calls: unknown[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(init?.body as string));
    const a = list[Math.min(i++, list.length - 1)]!;
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { fetchImpl, calls, sleep: async () => {} };
}

describe('confirmStep', () => {
  it('asks again while the network is finalising, then returns the confirmed lines', async () => {
    const f = answers(
      { status: 202, body: { status: 'pending' } },
      { status: 200, body: { status: 'confirmed', lines: ['Repaid 5 USDC on Burrow'] } },
    );
    expect(await confirmStep(req, f)).toEqual({
      status: 'confirmed',
      lines: ['Repaid 5 USDC on Burrow'],
    });
    expect(f.calls).toEqual([req, req]);
  });

  it('returns a failed step as the server described it', async () => {
    const failed = {
      status: 'failed',
      lines: [],
      failure: { contract: 'contract.main.burrow.near', error: 'Price oracle disabled' },
      funds: 'No funds left your wallet.',
    };
    expect(await confirmStep(req, answers({ status: 200, body: failed }))).toEqual(failed);
  });

  it('gives up as unknown after the attempts, never as confirmed', async () => {
    const f = answers({ status: 202, body: { status: 'pending' } });
    const r = await confirmStep(req, { ...f, attempts: 3 });
    expect(r.status).toBe('unknown');
    expect(f.calls).toHaveLength(3);
  });

  it('a cascade the server has no record of is sent but unchecked, not failed', async () => {
    const f = answers({ status: 404, body: { error: 'unknown cascade' } });
    expect(await confirmStep(req, f)).toEqual({ status: 'unchecked' });
  });

  it('stops at once on a refusal and says why', async () => {
    const f = answers({
      status: 422,
      body: { error: 'this transaction is not a step of the prepared cascade' },
    });
    expect(await confirmStep(req, f)).toEqual({
      status: 'unknown',
      reason:
        'Could not confirm this step: this transaction is not a step of the prepared cascade.',
    });
    expect(f.calls).toHaveLength(1);
  });
});
