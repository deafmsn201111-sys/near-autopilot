import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (payload: never) => void;
const NEAR = 1010;
const EVM = 1;

const fake = vi.hoisted(() => {
  const state = {
    kits: 0,
    bases: [] as unknown[],
    nearBase: undefined as unknown,
    connectorIds: [] as string[],
    account: null as string | null,
    walletIdAsked: undefined as unknown,
    sent: [] as unknown[],
    kitWallets: [] as { type: number; address: string }[],
    disconnected: [] as number[],
    pick: null as { type: number; address: string } | null,
    nearSignedOut: false,
    hang: false,
    connectorsRequested: false,
  };
  const events = new Map<string, Set<Listener>>();
  const emit = (name: string, payload: unknown) => {
    for (const l of events.get(name) ?? []) l(payload as never);
  };
  const baseWallet = {
    signAndSendTransaction: async (tx: unknown) => {
      state.sent.push(tx);
      return { transaction_outcome: { id: `hash-${state.sent.length}` } };
    },
  };
  class NearConnector {
    constructor(options: unknown) {
      state.bases.push(options);
    }
    async getConnectedWallet() {
      if (!state.account) throw new Error('No accounts found');
      return { wallet: baseWallet, accounts: [{ accountId: state.account }] };
    }
    get availableWallets() {
      return [{ manifest: { id: 'hot-wallet' } }];
    }
    off(name: string, l: Listener) {
      events.get(name)?.delete(l);
    }
    async connect(input: unknown) {
      state.walletIdAsked = input;
      return baseWallet;
    }
    async disconnect() {
      await Promise.resolve();
      state.nearSignedOut = true;
      state.account = null;
      emit('wallet:signOut', { success: true });
    }
    on(name: string, l: Listener) {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(l);
    }
    once(name: string, l: Listener) {
      const once = ((p: never) => {
        events.get(name)!.delete(once);
        l(p);
      }) as Listener;
      this.on(name, once);
    }
  }
  class HotKit {
    constructor(options: { connectors: { id: string; create: (m: unknown) => unknown }[] }) {
      state.kits++;
      state.connectorIds = options.connectors.map((c) => c.id);
      options.connectors[0]!.create({ default: (base: unknown) => (state.nearBase = base) });
    }
    get wallets() {
      return state.kitWallets;
    }
    onConnect() {
      return () => undefined;
    }
    onDisconnect() {
      return () => undefined;
    }
    async requestConnectors() {
      state.connectorsRequested = true;
    }
    async connect() {
      if (state.hang) return new Promise(() => undefined);
      const w = state.pick;
      if (!w) throw new Error('User rejected');
      state.kitWallets = [...state.kitWallets, w];
      if (w.type === NEAR) {
        state.account = w.address;
        emit('wallet:signIn', { accounts: [{ accountId: w.address }] });
      }
      return w;
    }
    async disconnect(w: { type: number }) {
      state.disconnected.push(w.type);
      state.kitWallets = state.kitWallets.filter((x) => x !== w);
      if (w.type === NEAR) void new NearConnector({}).disconnect();
    }
  }
  return { state, events, emit, HotKit, NearConnector };
});

vi.mock('@hot-labs/kit', () => ({ HotKit: fake.HotKit }));
vi.mock('@hot-labs/near-connect', () => ({ NearConnector: fake.NearConnector }));
vi.mock('@hot-labs/kit/defaults', () => ({
  lazyConnector: (id: string, _load: unknown, create: unknown) => ({ id, create }),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
});
vi.stubGlobal('document', { querySelector: () => null });

async function fresh({ session = null as string | null } = {}) {
  vi.resetModules();
  fake.events.clear();
  Object.assign(fake.state, {
    kits: 0,
    bases: [],
    nearBase: undefined,
    connectorIds: [],
    account: session,
    walletIdAsked: undefined,
    sent: [],
    kitWallets: session ? [{ type: NEAR, address: session }] : [],
    disconnected: [],
    pick: null,
    nearSignedOut: false,
    hang: false,
    connectorsRequested: false,
  });
  localStorage.clear();
  if (session) localStorage.setItem('selected-wallet', 'hot-wallet');
  return import('../lib/wallet');
}

describe('NEAR wallet through HOT Kit', () => {
  beforeEach(() => localStorage.clear());

  it('loads nothing on a page without a stored session', async () => {
    const m = await fresh();
    const seen: unknown[] = [];
    m.watchAccount((id) => seen.push(id));
    await flush();
    expect(seen).toEqual([null]);
    expect(await m.currentAccount()).toBeNull();
    expect(fake.state.kits).toBe(0);
  });

  it('restores a stored near-connect session through the kit, with the CSP nonce and no access key', async () => {
    const m = await fresh({ session: 'alice.near' });
    const seen: unknown[] = [];
    m.watchAccount((id) => seen.push(id));
    await vi.waitFor(() => expect(seen).toEqual(['alice.near']));
    expect(fake.state.kits).toBe(1);
    expect(fake.state.connectorIds).toEqual(['near', 'evm', 'solana', 'utxo']);
    expect(fake.state.bases).toEqual([
      expect.objectContaining({
        network: 'mainnet',
        features: { signInWithoutAddKey: true },
      }),
    ]);
    expect(fake.state.nearBase).toBeInstanceOf(fake.NearConnector);
  });

  it("turns the kit's wallet id into near-connect 0.12's connect input", async () => {
    await fresh({ session: 'alice.near' });
    const { currentAccount } = await import('../lib/wallet');
    await currentAccount();
    await (fake.state.nearBase as { connect: (id: string) => Promise<unknown> }).connect(
      'hot-wallet',
    );
    expect(fake.state.walletIdAsked).toEqual({ walletId: 'hot-wallet' });
  });

  it('refuses a wallet the near-connect features filter leaves out', async () => {
    await fresh({ session: 'alice.near' });
    const { currentAccount } = await import('../lib/wallet');
    await currentAccount();
    const base = fake.state.nearBase as { connect: (id: string) => Promise<unknown> };
    await expect(base.connect('adds-a-key-wallet')).rejects.toThrow(/without adding a key/);
    expect(fake.state.walletIdAsked).toBeUndefined();
  });

  it('reports account changes and sign-out', async () => {
    const m = await fresh({ session: 'alice.near' });
    const seen: unknown[] = [];
    m.watchAccount((id) => seen.push(id));
    await vi.waitFor(() => expect(seen).toEqual(['alice.near']));
    fake.emit('wallet:signIn', { accounts: [{ accountId: 'bob.near' }] });
    fake.emit('wallet:signOut', { success: true });
    expect(seen).toEqual(['alice.near', 'bob.near', null]);
  });

  it('connect resolves with the NEAR account picked in the kit picker', async () => {
    const m = await fresh();
    fake.state.pick = { type: NEAR, address: 'carol.near' };
    expect(await m.connect()).toBe('carol.near');
    expect(await m.currentAccount()).toBe('carol.near');
  });

  it('connect resolves null when only an EVM wallet was picked, or the picker closed', async () => {
    const m = await fresh();
    fake.state.pick = { type: EVM, address: '0xabc' };
    expect(await m.connect()).toBeNull();
    fake.state.pick = null;
    expect(await m.connect()).toBeNull();
  });

  it('only the latest of several open connect clicks gets the account', async () => {
    const m = await fresh();
    fake.state.hang = true;
    const first = m.connect();
    const second = m.connect();
    await vi.waitFor(() => expect(fake.events.get('wallet:signIn')?.size).toBe(3));
    fake.state.account = 'carol.near';
    fake.emit('wallet:signIn', { accounts: [{ accountId: 'carol.near' }] });
    expect(await Promise.all([first, second])).toEqual([null, 'carol.near']);
    expect(fake.events.get('wallet:signIn')?.size).toBe(1);
  });

  it('forgets a sign-in cancelled in the wallet, so the next page load skips the kit', async () => {
    const m = await fresh();
    localStorage.setItem('selected-wallet', 'hot-wallet');
    expect(await m.currentAccount()).toBeNull();
    expect(localStorage.getItem('selected-wallet')).toBeNull();
    vi.resetModules();
    fake.state.kits = 0;
    expect(await (await import('../lib/wallet')).currentAccount()).toBeNull();
    expect(fake.state.kits).toBe(0);
  });

  it('opens the account once when its sign-in lands after the list was closed', async () => {
    const m = await fresh();
    const late: string[] = [];
    expect(await m.connect((id) => late.push(id))).toBeNull();
    fake.emit('wallet:signIn', { accounts: [{ accountId: 'carol.near' }] });
    fake.emit('wallet:signIn', { accounts: [{ accountId: 'carol.near' }] });
    await flush();
    expect(late).toEqual(['carol.near']);
  });

  it('keeps the session key while a sign-in may still land after the list closed', async () => {
    const m = await fresh();
    await m.connect();
    localStorage.setItem('selected-wallet', 'hot-wallet');
    expect(await m.currentAccount()).toBeNull();
    expect(localStorage.getItem('selected-wallet')).toBe('hot-wallet');
  });

  it('waits for no late sign-in after an EVM-only pick', async () => {
    const m = await fresh();
    fake.state.pick = { type: EVM, address: '0xabc' };
    const late: string[] = [];
    expect(await m.connect((id) => late.push(id))).toBeNull();
    fake.emit('wallet:signIn', { accounts: [{ accountId: 'carol.near' }] });
    await flush();
    expect(late).toEqual([]);
    expect(fake.events.get('wallet:signIn')?.size).toBe(1);
  });

  it("a new closed list drops the previous one's pending sign-in listener", async () => {
    const m = await fresh();
    await m.connect();
    await m.connect();
    await m.connect();
    expect(fake.events.get('wallet:signIn')?.size).toBe(2);
  });

  it('a later click takes over a sign-in left pending by a closed list', async () => {
    const m = await fresh();
    const late: string[] = [];
    expect(await m.connect((id) => late.push(id))).toBeNull();
    fake.state.hang = true;
    const second = m.connect((id) => late.push(`second:${id}`));
    await flush();
    fake.emit('wallet:signIn', { accounts: [{ accountId: 'carol.near' }] });
    expect(await second).toBe('carol.near');
    await flush();
    expect(late).toEqual([]);
    expect(fake.events.get('wallet:signIn')?.size).toBe(1);
  });

  it('disconnect signs out of every connected wallet', async () => {
    const m = await fresh({ session: 'alice.near' });
    fake.state.kitWallets = [...fake.state.kitWallets, { type: EVM, address: '0xabc' }];
    const seen: unknown[] = [];
    m.watchAccount((id) => seen.push(id));
    await vi.waitFor(() => expect(seen).toEqual(['alice.near']));
    await m.disconnect();
    expect(fake.state.connectorsRequested).toBe(true);
    expect(fake.state.nearSignedOut).toBe(true);
    expect(fake.state.disconnected).toEqual([EVM]);
    expect(seen.at(-1)).toBeNull();
  });

  it('signs a cascade with the connected wallet, actions passed through unchanged', async () => {
    await fresh({ session: 'alice.near' });
    const { signCascade } = await import('../lib/wallet-sign');
    const action = { methodName: 'ft_transfer_call', args: { a: 1 }, gas: '30', deposit: '1' };
    const r = await signCascade(
      [{ intentId: 'i', receiverId: 'usdt.tether-token.near', actions: [action] }],
      'alice.near',
      true,
    );
    expect(r).toEqual({ ok: true, hashes: ['hash-1'] });
    expect(fake.state.sent).toEqual([
      {
        network: 'mainnet',
        signerId: 'alice.near',
        receiverId: 'usdt.tether-token.near',
        actions: [{ type: 'FunctionCall', params: action }],
      },
    ]);
  });
});
