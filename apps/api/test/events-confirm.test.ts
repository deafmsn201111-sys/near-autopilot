import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  NearRpcClient,
  NearTransactionStatusReader,
  type TxOutcome,
} from '@near-autopilot/near-adapter';
import { registerConfirm } from '../src/wallet/confirm';
import { MemoryEventStore } from './support/memory-events';

const ACCOUNT = 'autopilot-test.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const CASCADE = '6f9d2a52-3c3e-4c39-9d43-2f1f0b6c1a11';
const REPAY = '4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR';
const FAILED = '8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt21';
const MADE_UP = '8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt22';
const NOW = new Date('2026-11-14T10:00:00Z');

// Real mainnet answers (packages/near-adapter/test/fixtures), read through the real reader.
async function recorded(name: string): Promise<TxOutcome | null> {
  const body = readFileSync(
    new URL(`../../../packages/near-adapter/test/fixtures/${name}.json`, import.meta.url),
    'utf8',
  );
  const rpc = new NearRpcClient({
    url: 'http://rpc.invalid',
    fetchImpl: (async () => new Response(body)) as typeof fetch,
  });
  return new NearTransactionStatusReader(rpc).status('h', ACCOUNT);
}

const CHAIN: Record<string, string> = {
  [REPAY]: 'tx-burrow-repay',
  [FAILED]: 'tx-burrow-oracle-failed',
  [MADE_UP]: 'tx-unknown',
};

async function setup(override?: (o: TxOutcome) => TxOutcome) {
  const events = new MemoryEventStore();
  await events.add({
    at: NOW,
    kind: 'prepare',
    accountId: ACCOUNT,
    source: 'server',
    cascadeId: CASCADE,
    intent: { action: 'repay' },
    verdict: 'ALLOW',
    detail: {
      steps: [
        { intentId: 'repay', receiverId: USDC, methods: ['ft_transfer_call'] },
        { intentId: 'withdraw', receiverId: 'priceoracle.near', methods: ['oracle_call'] },
      ],
      preview: ['Repay 5 USDC', 'Withdraw collateral'],
    },
  });
  const app = Fastify();
  registerConfirm(app, {
    events,
    txs: {
      status: async (hash) => {
        const out = await recorded(CHAIN[hash] ?? 'tx-unknown');
        return out && override ? override(out) : out;
      },
    },
    burrowId: 'contract.main.burrow.near',
    tokens: async () => new Map([[USDC, { symbol: 'USDC', decimals: 6 }]]),
    now: () => NOW,
  });
  const confirm = (hash: string, step = 0, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/wallet/confirm',
      payload: { account: ACCOUNT, cascadeId: CASCADE, step, hash, ...extra },
    });
  const signedRows = () => events.rows.filter((r) => r.kind === 'signed');
  return { confirm, signedRows };
}

describe('POST /v1/wallet/confirm', () => {
  it('writes one signed row with the real amounts when RPC shows the step succeeded', async () => {
    const { confirm, signedRows } = await setup();
    const res = await confirm(REPAY);
    expect(res.json()).toEqual({ status: 'confirmed', lines: ['Repaid 5.010563 USDC on Burrow'] });
    expect(signedRows()).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT,
        cascadeId: CASCADE,
        txHash: REPAY,
        source: 'rpc',
        detail: { step: 'repay', receiverId: USDC, lines: ['Repaid 5.010563 USDC on Burrow'] },
      }),
    ]);
    expect(signedRows()[0]).not.toHaveProperty('ip');
  });

  it('stores a hash confirmed twice once', async () => {
    const { confirm, signedRows } = await setup();
    await confirm(REPAY);
    expect((await confirm(REPAY)).json()).toMatchObject({ status: 'confirmed' });
    expect(signedRows()).toHaveLength(1);
  });

  it('a failed step says which contract failed and why, and writes nothing', async () => {
    const { confirm, signedRows } = await setup();
    const res = await confirm(FAILED, 1);
    expect(res.json()).toMatchObject({
      status: 'failed',
      failure: { contract: 'contract.main.burrow.near', error: 'Price oracle disabled' },
      funds: 'No funds left your wallet.',
    });
    expect(signedRows()).toHaveLength(0);
  });

  it('a hash the network does not know is pending and writes nothing', async () => {
    const { confirm, signedRows } = await setup();
    const res = await confirm(MADE_UP);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'pending' });
    expect(signedRows()).toHaveLength(0);
  });

  it('a transaction signed by someone else writes nothing', async () => {
    const { confirm, signedRows } = await setup((o) => ({ ...o, signerId: 'mallory.near' }));
    const res = await confirm(REPAY);
    expect(res.statusCode).toBe(422);
    expect(signedRows()).toHaveLength(0);
  });

  it('a transaction that is not this step of the cascade writes nothing', async () => {
    const { confirm, signedRows } = await setup();
    const res = await confirm(REPAY, 1);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'this transaction is not a step of the prepared cascade' });
    expect(signedRows()).toHaveLength(0);
  });

  it('an unknown cascade or another account gets a short error', async () => {
    const { confirm } = await setup();
    const other = await confirm(REPAY, 0, { cascadeId: '00000000-0000-4000-8000-000000000000' });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: 'unknown cascade' });
    expect((await confirm(REPAY, 0, { account: 'bob.near' })).statusCode).toBe(404);
    expect((await confirm('not-a-hash')).statusCode).toBe(400);
  });
});
