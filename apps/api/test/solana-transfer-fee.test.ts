import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { SolanaTransferFees } from '../src/gateway/solana-transfer-fee';

const URL = 'https://solana.example';
const NEARKAT = '6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const addr = (i: number) => base58.encode(new Uint8Array(32).fill(i + 1));
const A = addr(0);
const B = addr(1);
const HOOK = addr(2);
const NO_HOOK = addr(3);
const PAUSED = addr(4);
const FROZEN = addr(5);
const DELEGATE = addr(6);
const SOULBOUND = addr(7);
const PLAIN_2022 = addr(8);

const fee = (older: number, newer: number) => ({
  extension: 'transferFeeConfig',
  state: {
    newerTransferFee: { epoch: 1029, maximumFee: 1e15, transferFeeBasisPoints: newer },
    olderTransferFee: { epoch: 1029, maximumFee: 1e15, transferFeeBasisPoints: older },
    withheldAmount: 30646179704,
  },
});
const mint = (extensions?: object[]) => ({
  data: {
    parsed: { type: 'mint', info: { decimals: 6, ...(extensions ? { extensions } : {}) } },
    program: extensions ? 'spl-token-2022' : 'spl-token',
  },
  owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
});
const ACCOUNTS: Record<string, unknown> = {
  [NEARKAT]: mint([{ extension: 'metadataPointer', state: {} }, fee(300, 300)]),
  [USDC]: mint(),
  [PYUSD]: mint([fee(0, 0)]),
};

function fakeRpc(accounts: Record<string, unknown> = ACCOUNTS) {
  const asked: string[][] = [];
  let fail = false;
  let gate: Promise<void> | null = null;
  const http = {
    postJson: async (url: string, body: unknown) => {
      expect(url).toBe(URL);
      await gate;
      if (fail) throw new Error('rpc down');
      const { method, params } = body as { method: string; params: [string[], object] };
      expect(method).toBe('getMultipleAccounts');
      expect(params[1]).toEqual({ encoding: 'jsonParsed' });
      asked.push(params[0]);
      return {
        jsonrpc: '2.0',
        id: 1,
        result: { value: params[0].map((m) => accounts[m] ?? null) },
      };
    },
  };
  const hold = () => {
    let open = () => {};
    gate = new Promise((r) => (open = r));
    return open;
  };
  return { http, asked, failNext: () => (fail = true), hold };
}

describe('SolanaTransferFees', () => {
  it('flags a mint with a non-zero transfer fee and passes a plain or zero-fee mint', async () => {
    const rpc = fakeRpc();
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL });
    expect(await fees.unsafe([NEARKAT, USDC, PYUSD])).toEqual(new Set([NEARKAT]));
    expect(rpc.asked).toEqual([[NEARKAT, USDC, PYUSD]]);
  });

  it('flags a fee that only the scheduled (newer) or the still active (older) setting charges', async () => {
    const rpc = fakeRpc({ [A]: mint([fee(0, 50)]), [B]: mint([fee(50, 0)]) });
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL });
    expect(await fees.unsafe([A, B])).toEqual(new Set([A, B]));
  });

  it('flags any Token-2022 extension that can block or tax a transfer, and passes harmless ones', async () => {
    const ext = (extension: string, state: object = {}) => ({ extension, state });
    const rpc = fakeRpc({
      [HOOK]: mint([ext('transferHook', { programId: 'Hook111' })]),
      [NO_HOOK]: mint([ext('transferHook', { programId: null }), ext('tokenMetadata')]),
      [PAUSED]: mint([ext('pausableConfig', { paused: false })]),
      [FROZEN]: mint([ext('defaultAccountState', { accountState: 'frozen' })]),
      [DELEGATE]: mint([ext('permanentDelegate', { delegate: 'X' })]),
      [SOULBOUND]: mint([ext('nonTransferable')]),
      [PLAIN_2022]: mint([
        ext('metadataPointer'),
        ext('mintCloseAuthority'),
        ext('groupMemberPointer'),
      ]),
    });
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL });
    const all = [HOOK, NO_HOOK, PAUSED, FROZEN, DELEGATE, SOULBOUND, PLAIN_2022];
    expect(await fees.unsafe(all)).toEqual(new Set([HOOK, PAUSED, FROZEN, DELEGATE, SOULBOUND]));
  });

  it('flags a missing account or one that is not a mint', async () => {
    const rpc = fakeRpc({ [A]: { data: { parsed: { type: 'account', info: {} } } } });
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL });
    expect(await fees.unsafe([A, B])).toEqual(new Set([A, B]));
  });

  it('reads each mint once per 10 minutes, in batches of at most 100', async () => {
    let t = 0;
    const many = Array.from({ length: 150 }, (_, i) => addr(i));
    const rpc = fakeRpc(Object.fromEntries(many.map((m) => [m, mint()])));
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL, now: () => t });
    expect(await fees.unsafe(many)).toEqual(new Set());
    expect(rpc.asked.map((b) => b.length)).toEqual([100, 50]);
    t = 9 * 60_000;
    await fees.unsafe(many);
    expect(rpc.asked).toHaveLength(2);
    t = 11 * 60_000;
    await fees.unsafe(many);
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc.asked).toHaveLength(4);
  });

  it('answers from the last read at once and refreshes in the background', async () => {
    let t = 0;
    const rpc = fakeRpc();
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL, now: () => t });
    await fees.unsafe([NEARKAT, USDC]);
    const release = rpc.hold();
    t = 11 * 60_000;
    expect(await fees.unsafe([NEARKAT, USDC])).toEqual(new Set([NEARKAT]));
    release();
  });

  it('keeps the last answer when the RPC fails, and flags a mint it never read', async () => {
    let t = 0;
    const rpc = fakeRpc();
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL, now: () => t });
    await fees.unsafe([NEARKAT, USDC]);
    t = 30 * 60_000;
    rpc.failNext();
    expect(await fees.unsafe([NEARKAT, USDC, PYUSD])).toEqual(new Set([NEARKAT, PYUSD]));
  });
});

describe('SolanaTransferFees, concurrent callers', () => {
  it('share one RPC read', async () => {
    const rpc = fakeRpc();
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL });
    const [a, b] = await Promise.all([fees.unsafe([NEARKAT, USDC]), fees.unsafe([NEARKAT, USDC])]);
    expect(rpc.asked).toHaveLength(1);
    expect(a).toEqual(new Set([NEARKAT]));
    expect(b).toEqual(new Set([NEARKAT]));
  });
});

describe('SolanaTransferFees, RPC down', () => {
  it('waits a minute after a failed read before asking again', async () => {
    let t = 0;
    let calls = 0;
    const http = {
      postJson: async () => {
        calls += 1;
        throw new Error('rpc down');
      },
    };
    const fees = new SolanaTransferFees({ http, url: URL, now: () => t });
    expect(await fees.unsafe([USDC])).toEqual(new Set([USDC]));
    t = 59_000;
    await fees.unsafe([USDC]);
    expect(calls).toBe(1);
    t = 60_000;
    await fees.unsafe([USDC]);
    expect(calls).toBe(2);
  });
});

describe('SolanaTransferFees, limits', () => {
  it('stops trusting a last answer older than an hour while the RPC stays down', async () => {
    let t = 0;
    const rpc = fakeRpc();
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL, now: () => t });
    await fees.unsafe([USDC]);
    rpc.failNext();
    t = 59 * 60_000;
    expect(await fees.unsafe([USDC])).toEqual(new Set());
    t = 61 * 60_000;
    expect(await fees.unsafe([USDC])).toEqual(new Set([USDC]));
  });

  it('never sends a string that is not a Solana address, so one bad entry cannot fail the batch', async () => {
    const rpc = fakeRpc();
    const fees = new SolanaTransferFees({ http: rpc.http, url: URL });
    expect(await fees.unsafe([USDC, 'not a mint', ''])).toEqual(new Set(['not a mint', '']));
    expect(rpc.asked).toEqual([[USDC]]);
  });
});
