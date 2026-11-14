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
  };
  class HotKit {
    constructor(options: unknown) {
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
