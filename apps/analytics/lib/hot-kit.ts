'use client';
import type { BridgeSetup, ChainId, HotKit, Recipient, Token } from '@hot-labs/kit';
import type { OmniWallet } from '@hot-labs/kit/core';
import type { KitTheme } from '@hot-labs/kit/ui';
import type { EventMap, NearConnector } from '@hot-labs/near-connect';

/**
 * EVERY WALLET THROUGH ONE HOT KIT (@hot-labs/kit): NEAR (lib/wallet.ts reads it), EVM, Solana, Tron and Bitcoin (the
 * deposit bridge, and the address a withdrawal goes to).
 * The kit's NEAR connector runs on our own near-connect 0.12 instance, not the kit's bundled 0.8.2: only 0.12 passes the
 * CSP nonce to the wallet iframes (D11), and it connects without adding an access key. It keeps near-connect's
 * `selected-wallet` session, so a NEAR wallet connected before stays connected.
 * The kit (and every chain SDK it pulls in) is imported on first use, never on page load. Nothing here signs NEAR
 * transactions (lib/wallet-sign.ts does); the only send is the one HOT's bridge popup builds for a deposit (D42).
 */
export type OriginChain = 'evm' | 'solana' | 'tron' | 'btc';
export interface OriginWallet {
  chain: OriginChain;
  address: string;
}

// WalletType.EVM / SOLANA / Tron / Btc / NEAR, inlined so this module stays free of a runtime kit import.
const TYPE_BY_CHAIN: Record<OriginChain, number> = { evm: 1, solana: 1001, tron: 333, btc: -6 };
const CHAIN_BY_TYPE: Record<number, OriginChain> = {
  1: 'evm',
  1001: 'solana',
  333: 'tron',
  [-6]: 'btc',
};
export const CHAIN_LABEL: Record<OriginChain, string> = {
  evm: 'EVM',
  solana: 'Solana',
  tron: 'Tron',
  btc: 'Bitcoin',
};
export const ORIGIN_CHAINS = Object.keys(CHAIN_LABEL) as OriginChain[];
export const NEAR_WALLET_TYPE = 1010;
export type NearSignIn = EventMap['wallet:signIn'];

interface Loaded {
  kit: HotKit;
  near: NearConnector;
}

let loaded: Promise<Loaded> | null = null;
const listeners = new Set<(wallets: OriginWallet[]) => void>();

function nearConnector(Base: typeof NearConnector): NearConnector {
  const near = new Base({
    network: 'mainnet',
    autoConnect: true,
    features: { signInWithoutAddKey: true },
    cspNonce:
      globalThis.document?.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined,
  });
  // kit 2.0.0 calls connect(walletId), near-connect 0.8's form; 0.12 takes { walletId } and would open its own picker.
  // The kit lists every manifest wallet, so the `features` filter is applied here.
  const connect = near.connect.bind(near);
  near.connect = (input) => {
    if (typeof input !== 'string') return connect(input);
    if (!near.availableWallets.some((w) => w.manifest.id === input))
      return Promise.reject(new Error('This wallet cannot connect without adding a key.'));
    return connect({ walletId: input });
  };
  return near;
}

/** The kit and its NEAR connector, created once on first use. */
export function loadKit(): Promise<Loaded> {
  loaded ??= (async () => {
    const [{ HotKit }, { lazyConnector }, nearConnect, { walletConnectProjectIdSchema }] =
      await Promise.all([
        import('@hot-labs/kit'),
        import('@hot-labs/kit/defaults'),
        import('@hot-labs/near-connect'),
        import('@near-autopilot/config'),
      ]);
    const near = nearConnector(nearConnect.NearConnector);
    const theme = pageTheme();
    const projectId = walletConnectProjectIdSchema.safeParse(
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
    ).data;
    const k = new HotKit({
      ...(projectId && {
        walletConnect: {
          projectId,
          metadata: {
            name: 'NEAR Autopilot',
            description: 'AI DeFi analyst for NEAR: you sign every transaction in your own wallet.',
            url: window.location.origin,
            icons: [],
          },
        },
      }),
      connectors: [
        lazyConnector(
          'near',
          () => import('@hot-labs/kit/near'),
          // ponytail: the kit types its base as near-connect 0.8.2; 0.12 has the same wallet API the kit calls
          (m) => m.default(near as unknown as Parameters<typeof m.default>[0]),
          { eager: true },
        ),
        lazyConnector(
          'evm',
          () => import('@hot-labs/kit/evm'),
          (m) => m.default(),
        ),
        lazyConnector(
          'solana',
          () => import('@hot-labs/kit/solana'),
          (m) => m.default(),
        ),
        lazyConnector(
          'tron',
          () => import('@hot-labs/kit/tron'),
          (m) => m.default(),
        ),
        lazyConnector(
          'utxo',
          () => import('@hot-labs/kit/utxo'),
          (m) => m.default(),
        ),
      ],
      ...(theme && { ui: { theme } }),
    });
    // HOT's "Deposit to HOT Balance" flow takes NEAR tokens and an editable recipient, ignoring the bridge setup (D42).
    const { openSelectSender } = k.router;
    Object.assign(k.router, {
      openSelectSender: (props: Parameters<typeof openSelectSender>[0]) =>
        openSelectSender({ ...props, depositFlow: false }),
      openDepositFlow: () => Promise.reject(new Error('Deposits go to the NEAR account only.')),
    });
    const emit = () => {
      const now = originWallets(k.wallets);
      for (const l of listeners) l(now);
    };
    k.onConnect(emit);
    k.onDisconnect(emit);
    return { kit: k, near };
  })().catch((e: unknown) => {
    loaded = null;
    throw e;
  });
  return loaded;
}

const load = async () => (await loadKit()).kit;

function originWallets(wallets: OmniWallet[]): OriginWallet[] {
  return wallets.flatMap((w) => {
    const chain = CHAIN_BY_TYPE[w.type];
    return chain && w.address ? [{ chain, address: w.address }] : [];
  });
}

/** Calls `onChange` with the connected EVM / Solana / Tron / Bitcoin wallets now and on every connect / disconnect. */
export function watchOriginWallets(onChange: (wallets: OriginWallet[]) => void): () => void {
  listeners.add(onChange);
  void load().then(
    (k) => listeners.has(onChange) && onChange(originWallets(k.wallets)),
    () => undefined,
  );
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Opens the kit's wallet picker for one chain; resolves with the wallet picked, null if closed. Per chain on purpose:
 * in kit 2.0.0 the all-chains picker never settles when its nested chain picker is closed.
 */
export async function connectOriginWallet(chain: OriginChain): Promise<OriginWallet | null> {
  try {
    const k = await load();
    return originWallets([await k.connect(TYPE_BY_CHAIN[chain])])[0] ?? null;
  } catch {
    return null;
  }
}

export async function disconnectOriginWallet(wallet: OriginWallet): Promise<void> {
  const k = await load();
  const w = k.wallets.find((x) => CHAIN_BY_TYPE[x.type] === wallet.chain);
  if (w) await k.disconnect(w);
}

function pageTheme(): KitTheme | undefined {
  if (typeof getComputedStyle !== 'function' || !document.documentElement) return undefined;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    colorScheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
    fontFamily: v('--font'),
    colors: {
      textPrimary: v('--text-1'),
      textSecondary: v('--text-2'),
      textTertiary: v('--text-3'),
      textInverse: v('--sign-ink'),
      accent: v('--accent'),
      accentOn: v('--sign-ink'),
      background: v('--bg-surface'),
      surface: v('--bg-raised'),
      surfaceLow: v('--bg-page'),
      surfaceHigh: v('--bg-overlay'),
      surfaceHighest: v('--bg-overlay'),
      border: v('--line-strong'),
      borderFocus: v('--accent'),
      success: v('--safe'),
      error: v('--liq'),
      warning: v('--watch'),
      overlay: v('--scrim'),
    },
    buttons: { primary: v('--sign'), primaryHover: v('--sign-hover') },
  };
}

const SOURCE_CHAINS = new Set<ChainId>(['sol', 'tron', 'btc']);

/**
 * Where a deposit may come from: an EVM chain 1Click serves, Solana, Tron or Bitcoin. Never NEAR or a HOT balance
 * (`hot`, `hotcraft`...): a send from there would be a NEAR signature around validateCascade (D42).
 */
export const isBridgeSource = (
  chain: ChainId,
  oneClickChain: (id: ChainId) => string | undefined,
) => (typeof chain === 'number' ? oneClickChain(chain) !== undefined : SOURCE_CHAINS.has(chain));

export function bridgeSetup(
  recipient: Recipient,
  oneClickChain: (id: ChainId) => string | undefined,
): BridgeSetup {
  return {
    title: 'Fund your NEAR account',
    recipient,
    lockRecipient: true,
    tokenFilter: {
      from: (t) => isBridgeSource(t.chain, oneClickChain),
      to: (t) => t.chain === 'near',
    },
  };
}

/**
 * Opens HOT's bridge popup to fund `account` from another chain: the account is the locked recipient, NEAR the only
 * destination. HOT builds the transfer and the user signs it in the origin wallet (D42). Resolves once it is open.
 */
export async function openDepositBridge(account: string, tokenId?: string): Promise<void> {
  const k = await load();
  const kit = await import('@hot-labs/kit');
  const recipient = await kit.Recipient.fromAddress('near', account);
  const theme = pageTheme();
  if (theme) k.setUIOptions({ theme });
  const held = k.walletsTokens.find(
    (t) => t.token.id === tokenId && isBridgeSource(t.token.chain, kit.toOneClickChain),
  );
  // The kit applies a preset `from` / `to` without its token filters: both are checked here.
  const twin =
    held && k.tokens.find((t) => t.chain === 'near' && !t.isOmni && t.symbol === held.token.symbol);
  const setup = bridgeSetup(recipient, kit.toOneClickChain);
  const preset = held && { from: held.token, sender: held.wallet, ...(twin && { to: twin }) };
  // Settles with the swap, whose result and errors HOT's popup shows itself.
  void k.openBridge({ setup: { ...setup, ...preset } }).catch(() => undefined);
}

export interface KitBalance {
  wallet: { type: number; address: string };
  balance: bigint;
  token: Pick<Token, 'id' | 'symbol' | 'chain' | 'chainName' | 'icon' | 'usd' | 'isOmni'> & {
    float(balance: bigint): number;
  };
}

export interface OtherHolding {
  key: string;
  tokenId: string;
  symbol: string;
  chainName: string;
  icon: string | null;
  amount: number;
  usd: number;
  bringable: boolean;
}

/** One connected origin wallet, or `hot`: the HOT (intents) balance, where a failed HOT swap refunds (D42). */
export interface OtherBalance {
  key: string;
  chain: OriginChain | 'hot';
  address: string;
  usd: number;
  items: OtherHolding[];
}

const DUST_USD = 0.01;

/**
 * The kit's balances outside the NEAR account, by wallet, valued at the kit's prices. Shown only: never sent to our
 * API, analysed or ranked. The NEAR wallet's own tokens are skipped (the API reads them from the chain).
 */
export function otherBalances(
  entries: readonly KitBalance[],
  oneClickChain: (id: ChainId) => string | undefined,
): OtherBalance[] {
  const groups = new Map<string, OtherBalance>();
  for (const { wallet, balance, token } of entries) {
    const chain = token.isOmni ? 'hot' : CHAIN_BY_TYPE[wallet.type];
    const amount = token.float(balance);
    const usd = amount * token.usd;
    if (!chain || !(usd >= DUST_USD)) continue;
    const key = chain === 'hot' ? 'hot' : `${chain}:${wallet.address}`;
    const group = groups.get(key) ?? { key, chain, address: wallet.address, usd: 0, items: [] };
    group.usd += usd;
    group.items.push({
      key: `${wallet.address}:${token.id}`,
      tokenId: token.id,
      symbol: token.symbol,
      chainName: token.chainName,
      icon: token.icon || null,
      amount,
      usd,
      bringable: chain !== 'hot' && isBridgeSource(token.chain, oneClickChain),
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Calls `onChange` with the other-chain balances now and whenever the kit reads new ones or a wallet (dis)connects. */
export function watchOtherBalances(onChange: (balances: OtherBalance[]) => void): () => void {
  let stop: (() => void) | null = null;
  let live = true;
  void load()
    .then(async (k) => {
      const [kit, { comparer, reaction }] = await Promise.all([
        import('@hot-labs/kit'),
        import('mobx'),
      ]);
      if (!live) return;
      stop = reaction(() => otherBalances(k.walletsTokens, kit.toOneClickChain), onChange, {
        fireImmediately: true,
        equals: comparer.structural,
      });
    })
    .catch(() => undefined);
  return () => {
    live = false;
    stop?.();
  };
}
