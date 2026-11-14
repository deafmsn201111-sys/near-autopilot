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
    senderProps: undefined as unknown,
  };
  class HotKit {
    router = {
      openSelectSender: (props: { depositFlow: boolean }) => (state.senderProps = props),
      openDepositFlow: async () => 'opened',
    };
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

vi.mock('@hot-labs/kit', () => ({
  HotKit: fake.HotKit,
}));
vi.mock('@hot-labs/near-connect', () => ({
  NearConnector: class {
    connect() {}
  },
}));
vi.mock('@hot-labs/kit/defaults', () => ({
  lazyConnector: (id: string) => id,
}));

const EVM = { type: 1, address: '0xabc0000000000000000000000000000000000001' };
const SOL = { type: 1001, address: 'So1anaAddre55' };
const TON = { type: 1111, address: 'EQton' };
const BTC = { type: -6, address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };

const PROXY = {
  oneClick: { baseUrl: '/api/hex/market/v1/1click' },
  marketRelay: '/api/hex/market',
};

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

  it('creates the kit lazily, once, with the NEAR, EVM, Solana, Tron and Bitcoin connectors', async () => {
    expect(fake.state.created).toBe(0);
    const stop1 = m.watchOriginWallets(() => undefined);
    const stop2 = m.watchOriginWallets(() => undefined);
    await m.connectOriginWallet('evm');
    await flush();
    expect(fake.state.created).toBe(1);
    expect(fake.state.options).toEqual({
      ...PROXY,
      connectors: ['near', 'evm', 'solana', 'tron', 'utxo'],
    });
    stop1();
    stop2();
  });

  it("never offers HOT's deposit-to-balance flow, which skips the bridge's filters (D42)", async () => {
    const { kit } = await m.loadKit();
    kit.router.openSelectSender({ depositFlow: true } as never);
    expect(fake.state.senderProps).toMatchObject({ depositFlow: false });
    await expect(kit.router.openDepositFlow(kit as never)).rejects.toThrow(/NEAR account/);
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
    fake.state.pick = { type: WalletType.Btc, address: BTC.address };
    expect(await m.connectOriginWallet('btc')).toEqual({ chain: 'btc', address: BTC.address });
    fake.state.pick = { type: WalletType.Tron, address: 'TTronAddre55' };
    expect(await m.connectOriginWallet('tron')).toEqual({
      chain: 'tron',
      address: 'TTronAddre55',
    });
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
      expect(fake.state.options).toEqual({
        ...PROXY,
        connectors: ['near', 'evm', 'solana', 'tron', 'utxo'],
      });
    }
    vi.unstubAllEnvs();
  });
});
