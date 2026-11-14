import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UnexpectedResponseError } from '@near-autopilot/core';
import { NearRpcClient, NearTransactionStatusReader } from '../src';

// Recorded from NEAR mainnet (archival RPC, method `tx`) for autopilot-test.near, 13–14 Nov 2026.
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

function reader(body: unknown) {
  const sent: unknown[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(init?.body as string));
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  const rpc = new NearRpcClient({ url: 'http://rpc.invalid', fetchImpl, sleep: async () => {} });
  return { txs: new NearTransactionStatusReader(rpc), sent };
}

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

describe('NearTransactionStatusReader', () => {
  it('asks for the final status by hash and signer, once', async () => {
    const { txs, sent } = reader(recorded('tx-unknown'));
    await txs.status('8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt22', 'autopilot-test.near');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'tx',
      params: {
        tx_hash: '8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt22',
        sender_account_id: 'autopilot-test.near',
        wait_until: 'FINAL',
      },
    });
  });

  it('reads a successful Burrow repay with its receipts and logs', async () => {
    const { txs } = reader(recorded('tx-burrow-repay'));
    const out = await txs.status('4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR', 'x');
    expect(out).toMatchObject({
      hash: '4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR',
      signerId: 'autopilot-test.near',
      receiverId: USDC,
      methods: ['ft_transfer_call'],
      ok: true,
    });
    const burrow = out?.receipts.find((r) => r.executorId === 'contract.main.burrow.near');
    expect(burrow?.failure).toBeNull();
    expect(burrow?.logs.some((l) => l.includes('"event":"repay"'))).toBe(true);
  });

  it('reads a failed oracle call: which contract failed and its error', async () => {
    const { txs } = reader(recorded('tx-burrow-oracle-failed'));
    const out = await txs.status('8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt21', 'x');
    expect(out?.ok).toBe(false);
    expect(out?.methods).toEqual(['oracle_call']);
    expect(out?.calls[0]).toMatchObject({
      method: 'oracle_call',
      gas: '150000000000000',
      deposit: '1',
      args: { receiver_id: 'contract.main.burrow.near' },
    });
    const failed = out?.receipts.filter((r) => r.failure !== null);
    expect(failed).toHaveLength(1);
    expect(failed?.[0]?.executorId).toBe('contract.main.burrow.near');
    expect(failed?.[0]?.failure).toContain('Price oracle disabled');
  });

  it('gives the block of a transaction and that block time', async () => {
    const { txs } = reader(recorded('tx-burrow-repay'));
    const out = await txs.status('4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR', 'x');
    expect(out?.blockHash).toBe('9sGL3Yp7paz8YcL418SYTn2N14YM9jLiRTF8W7Ldorgf');
    // Header of that block, recorded from mainnet (other fields trimmed).
    const block = reader(recorded('block-of-burrow-repay'));
    expect((await block.txs.includedAt(out?.blockHash ?? '')).toISOString()).toBe(
      '2026-11-11T17:55:52.555Z',
    );
    expect(block.sent[0]).toMatchObject({
      method: 'block',
      params: { block_id: '9sGL3Yp7paz8YcL418SYTn2N14YM9jLiRTF8W7Ldorgf' },
    });
  });

  it('returns null while the status is not final', async () => {
    const final = recorded('tx-burrow-repay') as { result: Record<string, unknown> };
    const { txs } = reader({
      ...final,
      result: { ...final.result, final_execution_status: 'EXECUTED_OPTIMISTIC' },
    });
    expect(await txs.status('4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR', 'x')).toBeNull();
  });

  it('returns null for a hash the network does not know', async () => {
    const { txs } = reader(recorded('tx-unknown'));
    expect(await txs.status('8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt22', 'x')).toBeNull();
  });

  it('returns null while the node has not seen the transaction final yet', async () => {
    const { txs } = reader({
      jsonrpc: '2.0',
      id: 1,
      error: {
        name: 'HANDLER_ERROR',
        cause: { info: { cause: 'NOT_OBSERVED' }, name: 'TIMEOUT_ERROR' },
        code: -32000,
        message: 'Server error',
        data: 'Timeout',
      },
    });
    expect(await txs.status('C9oHgBzzaUPnvsBGsXJWBNPnWUYfccUMWNjR2fPcXP9h', 'x')).toBeNull();
  });

  it('refuses a malformed answer', async () => {
    const { txs } = reader({ jsonrpc: '2.0', id: 1, result: { status: 'weird' } });
    await expect(txs.status('C9oHgBzzaUPnvsBGsXJWBNPnWUYfccUMWNjR2fPcXP9h', 'x')).rejects.toThrow(
      UnexpectedResponseError,
    );
  });
});
