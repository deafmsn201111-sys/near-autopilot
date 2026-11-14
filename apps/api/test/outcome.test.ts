import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NearRpcClient,
  NearTransactionStatusReader,
  type TxOutcome,
} from '@near-autopilot/near-adapter';
import { describeOutcome } from '../src/wallet/outcome';

// Real mainnet answers recorded for autopilot-test.near (packages/near-adapter/test/fixtures).
async function recorded(name: string): Promise<TxOutcome> {
  const body = readFileSync(
    new URL(`../../../packages/near-adapter/test/fixtures/${name}.json`, import.meta.url),
    'utf8',
  );
  const rpc = new NearRpcClient({
    url: 'http://rpc.invalid',
    fetchImpl: (async () => new Response(body)) as typeof fetch,
  });
  const out = await new NearTransactionStatusReader(rpc).status('h', 'autopilot-test.near');
  if (!out) throw new Error(`fixture ${name} has no outcome`);
  return out;
}

const ACCOUNT = 'autopilot-test.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const tokens = new Map([
  [USDC, { symbol: 'USDC', decimals: 6 }],
  ['usdt.tether-token.near', { symbol: 'USDt', decimals: 6 }],
  ['wrap.near', { symbol: 'wNEAR', decimals: 24 }],
]);
const ctx = { account: ACCOUNT, burrowId: 'contract.main.burrow.near', tokens };

describe('describeOutcome', () => {
  it('a Burrow repay reads as the repaid amount', async () => {
    const d = describeOutcome(await recorded('tx-burrow-repay'), ctx);
    expect(d).toEqual({ ok: true, lines: ['Repaid 5.010563 USDC on Burrow'] });
  });

  it('a Burrow supply reads as the supplied amount', async () => {
    const d = describeOutcome(await recorded('tx-burrow-supply'), ctx);
    expect(d).toEqual({ ok: true, lines: ['Supplied 5.013695 USDt on Burrow'] });
  });

  it('a Rhea swap reads as what went in and what came out', async () => {
    const d = describeOutcome(await recorded('tx-rhea-swap'), ctx);
    expect(d).toEqual({ ok: true, lines: ['Swapped 10 USDC → 10.013695 USDt on Rhea'] });
  });

  it('a two-hop Rhea swap reads as the first token in and the last token out', async () => {
    const d = describeOutcome(await recorded('tx-rhea-swap-unwrap'), ctx);
    expect(d.lines).toEqual(['Swapped 4 USDt → 1.06712 wNEAR on Rhea']);
  });

  it('a failed oracle call names the contract, its error, and that no funds moved', async () => {
    const d = describeOutcome(await recorded('tx-burrow-oracle-failed'), ctx);
    expect(d).toEqual({
      ok: false,
      lines: [],
      failure: { contract: 'contract.main.burrow.near', error: 'Price oracle disabled' },
      funds: 'No funds left your wallet.',
    });
  });

  it('a failed transfer that came back says the refund is confirmed', () => {
    const transfer = (from: string, to: string) =>
      `EVENT_JSON:${JSON.stringify({
        standard: 'nep141',
        version: '1.0.0',
        event: 'ft_transfer',
        data: [{ old_owner_id: from, new_owner_id: to, amount: '120000000' }],
      })}`;
    const out: TxOutcome = {
      hash: 'h',
      signerId: ACCOUNT,
      receiverId: USDC,
      methods: ['ft_transfer_call'],
      calls: [],
      ok: false,
      receipts: [
        { executorId: USDC, logs: [transfer(ACCOUNT, 'contract.main.burrow.near')], failure: null },
        {
          executorId: 'contract.main.burrow.near',
          logs: [],
          failure: 'Smart contract panicked: E1',
        },
        { executorId: USDC, logs: [transfer('contract.main.burrow.near', ACCOUNT)], failure: null },
      ],
    };
    expect(describeOutcome(out, ctx)).toMatchObject({
      ok: false,
      failure: { contract: 'contract.main.burrow.near', error: 'E1' },
      funds: 'Refund confirmed: 120 USDC is back in your wallet.',
    });
  });

  it('a failed step whose tokens did not come back says so', () => {
    const out: TxOutcome = {
      hash: 'h',
      signerId: ACCOUNT,
      receiverId: 'wrap.near',
      methods: ['ft_transfer_call'],
      calls: [],
      ok: false,
      receipts: [
        {
          executorId: 'wrap.near',
          logs: [`Transfer 1000000000000000000000000 from ${ACCOUNT} to v2.ref-finance.near`],
          failure: null,
        },
        { executorId: 'v2.ref-finance.near', logs: [], failure: '{"ActionError":{}}' },
      ],
    };
    expect(describeOutcome(out, ctx).funds).toBe(
      '1 wNEAR left your wallet and did not come back yet: check the transaction.',
    );
  });
});
