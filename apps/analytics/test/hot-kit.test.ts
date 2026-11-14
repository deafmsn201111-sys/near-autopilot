import type * as KitCore from '@hot-labs/kit/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = () => void;
const fake = vi.hoisted(() => {
  const state = {
    created: 0,
    options: undefined as unknown,
    wallets: [] as { type: number; address: string }[],
    connected: [] as Handler[],
    disconnected: [] as Handler[],
    pick: null as { type: number; address: string } | null,
    failLoad: false,
  };
  class HotKit {
    constructor(options: unknown) {
      if (state.failLoad) throw new Error('chunk failed');
      state.created++;
      state.options = options;
    }
    get wallets() {
      return state.wallets;
    }
    onConnect(h: Handler) {
      state.connected.push(h);
      return () => undefined;
    }
    onDisconnect(h: Handler) {
      state.disconnected.push(h);
      return () => undefined;
    }
    async connect(type: number) {
      if (!state.pick || state.pick.type !== type) throw new Error('User rejected');
      state.wallets = [...state.wallets, state.pick];
      for (const h of state.connected) h();
      return state.pick;
    }
    async disconnect(w: { type: number }) {
      state.wallets = state.wallets.filter((x) => x !== w);
      for (const h of state.disconnected) h();
    }
  }
  return { state, HotKit };
});

vi.mock('@hot-labs/kit', () => ({ HotKit: fake.HotKit }));
vi.mock('@hot-labs/kit/defaults', () => ({
  lazyConnector: (id: string) => id,
}));

const EVM = { type: 1, address: '0xabc0000000000000000000000000000000000001' };
const SOL = { type: 1001, address: 'So1anaAddre55' };
const TON = { type: 1111, address: 'EQton' };

const flush = () => new Promise((r) => setTimeout(r, 0));

async function fresh() {
  vi.resetModules();
  Object.assign(fake.state, {
    created: 0,
    options: undefined,
    wallets: [],
    connected: [],
    disconnected: [],
    pick: null,
    failLoad: false,
  });
  return import('../lib/hot-kit');
}

describe('HOT Kit origin wallets', () => {
  let m: Awaited<ReturnType<typeof fresh>>;
  beforeEach(async () => {
    m = await fresh();
  });

  it('creates the kit lazily, once, with the EVM and Solana connectors only', async () => {
    expect(fake.state.created).toBe(0);
    const stop1 = m.watchOriginWallets(() => undefined);
    const stop2 = m.watchOriginWallets(() => undefined);
    await m.connectOriginWallet('evm');
    await flush();
    expect(fake.state.created).toBe(1);
    expect(fake.state.options).toEqual({ connectors: ['evm', 'solana'] });
    stop1();
    stop2();
  });

  it('reports the address on connect and clears it on disconnect', async () => {
    const seen: unknown[] = [];
    m.watchOriginWallets((w) => seen.push(w));
    await flush();
    fake.state.pick = EVM;
    expect(await m.connectOriginWallet('evm')).toEqual({ chain: 'evm', address: EVM.address });
    fake.state.pick = SOL;
    await m.connectOriginWallet('solana');
    await m.disconnectOriginWallet({ chain: 'evm', address: EVM.address });
    expect(seen).toEqual([
      [],
      [{ chain: 'evm', address: EVM.address }],
      [
        { chain: 'evm', address: EVM.address },
        { chain: 'solana', address: SOL.address },
      ],
      [{ chain: 'solana', address: SOL.address }],
    ]);
  });

  it('ignores wallets of other chains and a closed picker', async () => {
    fake.state.wallets = [TON];
    const seen: unknown[] = [];
    m.watchOriginWallets((w) => seen.push(w));
    expect(await m.connectOriginWallet('evm')).toBeNull();
    await flush();
    expect(seen).toEqual([[]]);
  });

  it('stops notifying after unsubscribe', async () => {
    const seen: unknown[] = [];
    const stop = m.watchOriginWallets((w) => seen.push(w));
    stop();
    fake.state.pick = EVM;
    await m.connectOriginWallet('evm');
    await flush();
    expect(seen).toEqual([]);
  });
});

describe('kit wallet type numbers', () => {
  it('match the WalletType enum of the installed kit', async () => {
    const { WalletType } = await vi.importActual<typeof KitCore>('@hot-labs/kit/core');
    const m = await fresh();
    fake.state.pick = { type: WalletType.EVM, address: EVM.address };
    expect(await m.connectOriginWallet('evm')).toEqual({ chain: 'evm', address: EVM.address });
    fake.state.pick = { type: WalletType.SOLANA, address: SOL.address };
    expect(await m.connectOriginWallet('solana')).toEqual({
      chain: 'solana',
      address: SOL.address,
    });
  });
});

describe('sendOriginTransfer', () => {
  const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const transfer = (chain: string, contractAddress: string | null, decimals = 6) => ({
    quoteId: 'dq_1',
    chain,
    receiver: 'DEPOSIT',
    amount: '1000000',
    token: { assetId: 'a', blockchain: chain, symbol: 'X', decimals, contractAddress },
  });
  type Sent = {
    token: { chain: unknown; address: string; decimals: number };
    receiver: string;
    amount: bigint;
  };
  const wallet = (w: { type: number; address: string }, sent: Sent[]) => ({
    ...w,
    transfer: async (args: Sent) => {
      sent.push(args);
      return '0xhash';
    },
  });
  const sentBy = async (t: ReturnType<typeof transfer>) => {
    const m = await fresh();
    const sent: Sent[] = [];
    fake.state.wallets = [wallet(EVM, sent), wallet(SOL, sent)];
    const hash = await m.sendOriginTransfer(t);
    const [s] = sent;
    return {
      hash,
      sent: sent.length,
      chain: s?.token.chain,
      address: s?.token.address,
      receiver: s?.receiver,
      amount: s?.amount,
    };
  };

  it('asks the EVM wallet for an ERC-20 or a native transfer on the quoted network, in base units', async () => {
    expect(await sentBy(transfer('base', BASE_USDC))).toEqual({
      hash: '0xhash',
      sent: 1,
      chain: 8453,
      address: BASE_USDC,
      receiver: 'DEPOSIT',
      amount: 1_000_000n,
    });
    expect(await sentBy(transfer('arb', null, 18))).toMatchObject({
      chain: 42161,
      address: 'native',
    });
    expect(await sentBy(transfer('eth', null, 18))).toMatchObject({ chain: 1, address: 'native' });
  });

  it('asks the Solana wallet for an SPL or a native SOL transfer', async () => {
    expect(await sentBy(transfer('sol', SOL_USDC))).toMatchObject({
      chain: 'sol',
      address: SOL_USDC,
    });
    expect(await sentBy(transfer('sol', null, 9))).toMatchObject({
      chain: 'sol',
      address: 'native',
    });
  });

  it('refuses without a connected wallet of that chain, and for Bitcoin', async () => {
    const m = await fresh();
    await expect(m.sendOriginTransfer(transfer('base', BASE_USDC))).rejects.toThrow(/Connect/);
    await expect(m.sendOriginTransfer(transfer('btc', null, 8))).rejects.toThrow();
  });
});

describe('kit load failure', () => {
  it('connect resolves null and the next call retries the load', async () => {
    const m = await fresh();
    fake.state.failLoad = true;
    expect(await m.connectOriginWallet('evm')).toBeNull();
    fake.state.failLoad = false;
    fake.state.pick = EVM;
    expect(await m.connectOriginWallet('evm')).toEqual({ chain: 'evm', address: EVM.address });
  });
});

describe('WalletConnect project id', () => {
  const ID = 'a'.repeat(32);

  it('is passed to the kit with the site metadata when the build set a valid one', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', ID);
    vi.stubGlobal('window', { location: { origin: 'https://site.test' } });
    const m = await fresh();
    await m.connectOriginWallet('evm');
    expect(fake.state.options).toMatchObject({
      walletConnect: { projectId: ID, metadata: { url: 'https://site.test' } },
    });
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('is left out when empty or malformed', async () => {
    for (const value of ['', 'not-an-id']) {
      vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', value);
      const m = await fresh();
      await m.connectOriginWallet('evm');
      expect(fake.state.options).toEqual({ connectors: ['evm', 'solana'] });
    }
    vi.unstubAllEnvs();
  });
});
