import type * as KitCore from '@hot-labs/kit/core';
import type * as Mobx from 'mobx';
import type { IObservableValue } from 'mobx';
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
    tokens: undefined as unknown as IObservableValue<unknown[]>,
    bridge: undefined as unknown,
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
    get walletsTokens() {
      return state.tokens.get();
    }
    setUIOptions() {}
    async openBridge(options: unknown) {
      state.bridge = options;
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
  Recipient: { fromAddress: async (chain: string, address: string) => ({ chain, address }) },
  toOneClickChain: (id: unknown) => (id === 8453 ? 'base' : undefined),
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

const flush = () => new Promise((r) => setTimeout(r, 0));

// The module registry is reset per test, mobx with it: the fake kit's observables come from the instance lib/ sees.
let mobx: typeof Mobx;

async function fresh() {
  vi.resetModules();
  mobx = await import('mobx');
  Object.assign(fake.state, {
    created: 0,
    options: undefined,
    wallets: [],
    connected: [],
    disconnected: [],
    pick: null,
    failLoad: false,
    tokens: mobx.observable.box([], { deep: false }),
    bridge: undefined,
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
        connectors: ['near', 'evm', 'solana', 'tron', 'utxo'],
      });
    }
    vi.unstubAllEnvs();
  });
});

const usdc = (wallet: { type: number; address: string }, amount: number) => ({
  wallet,
  balance: BigInt(amount * 1e6),
  token: {
    id: '8453:usdc',
    symbol: 'USDC',
    chain: 8453,
    chainName: 'Base',
    icon: '',
    usd: 1,
    isOmni: false,
    float: (b: bigint) => Number(b) / 1e6,
  },
});

describe('other-chain balances', () => {
  it('reports the kit balances now and on every change, until unsubscribed', async () => {
    const m = await fresh();
    const seen: number[][] = [];
    const stop = m.watchOtherBalances((groups) => seen.push(groups.map((g) => g.usd)));
    await vi.waitFor(() => expect(seen).toEqual([[]]));
    mobx.runInAction(() => fake.state.tokens.set([usdc(EVM, 20)]));
    mobx.runInAction(() => fake.state.tokens.set([]));
    stop();
    mobx.runInAction(() => fake.state.tokens.set([usdc(EVM, 5)]));
    expect(seen).toEqual([[], [20], []]);
  });

  it('Bring to NEAR preselects the token and its wallet, recipient still locked', async () => {
    const m = await fresh();
    const entry = usdc(EVM, 20);
    mobx.runInAction(() => fake.state.tokens.set([entry]));
    await m.openDepositBridge('alice.near', '8453:usdc');
    await flush();
    expect(fake.state.bridge).toMatchObject({
      setup: {
        recipient: { chain: 'near', address: 'alice.near' },
        lockRecipient: true,
        from: entry.token,
        sender: EVM,
      },
    });
  });

  it('opens without a preselected token when it is unknown or not a bridge source', async () => {
    const m = await fresh();
    await m.openDepositBridge('alice.near', 'hot:usdc');
    await flush();
    const setup = (fake.state.bridge as { setup: Record<string, unknown> }).setup;
    expect(setup.from).toBeUndefined();
    expect(setup.sender).toBeUndefined();
  });
});
