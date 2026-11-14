'use client';
import type { HotKit } from '@hot-labs/kit';
import type { OmniWallet } from '@hot-labs/kit/core';
import type { EventMap, NearConnector } from '@hot-labs/near-connect';
import { walletChainOf, type DepositTransfer, type SendFailure } from './deposit';

/**
 * EVERY WALLET THROUGH ONE HOT KIT (@hot-labs/kit): NEAR (lib/wallet.ts reads it), EVM, Solana and Bitcoin (the deposit
 * dialog). A Bitcoin wallet only gives its address; it is never asked to send (D34).
 * The kit's NEAR connector runs on our own near-connect 0.12 instance, not the kit's bundled 0.8.2: only 0.12 passes the
 * CSP nonce to the wallet iframes (D11), and it connects without adding an access key. It keeps near-connect's
 * `selected-wallet` session, so a NEAR wallet connected before stays connected.
 * The kit (and every chain SDK it pulls in) is imported on first use, never on page load. Nothing here signs NEAR
 * transactions (lib/wallet-sign.ts does); the only send is the deposit transfer below (D34).
 */
export type OriginChain = 'evm' | 'solana' | 'btc';
export interface OriginWallet {
  chain: OriginChain;
  address: string;
}

// WalletType.EVM / SOLANA / Btc / NEAR, inlined so this module stays free of a runtime kit import.
const TYPE_BY_CHAIN: Record<OriginChain, number> = { evm: 1, solana: 1001, btc: -6 };
const CHAIN_BY_TYPE: Record<number, OriginChain> = { 1: 'evm', 1001: 'solana', [-6]: 'btc' };
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
          'utxo',
          () => import('@hot-labs/kit/utxo'),
          (m) => m.default(),
        ),
      ],
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

/** Calls `onChange` with the connected EVM / Solana / Bitcoin wallets now and on every connect / disconnect. */
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

const EXPECTED_CHAIN: Record<string, number | string> = {
  eth: 1,
  base: 8453,
  arb: 42161,
  sol: 'sol',
};

/**
 * Asks the connected origin wallet to send exactly `t` (from loadDepositTransfer, already matched to the quote); the
 * wallet shows it and the user signs there. Resolves with the transaction hash. Throws before asking the wallet when
 * the kit would read the token as another network or contract than the transfer names.
 */
export async function sendOriginTransfer(t: DepositTransfer): Promise<string> {
  const chain = walletChainOf(t.chain);
  if (!chain) throw new Error('Send this deposit manually.');
  const [k, { Token }] = await Promise.all([load(), import('@hot-labs/kit/core')]);
  const w = k.wallets.find((x) => CHAIN_BY_TYPE[x.type] === chain);
  if (!w) throw new Error(`Connect your ${chain === 'evm' ? 'EVM' : 'Solana'} wallet first.`);
  const token = new Token({
    assetId: t.token.assetId,
    blockchain: t.token.blockchain,
    symbol: t.token.symbol,
    decimals: t.token.decimals,
    price: 0,
    priceUpdatedAt: '',
    ...(t.token.contractAddress && { contractAddress: t.token.contractAddress }),
  });
  if (
    token.chain !== EXPECTED_CHAIN[t.chain] ||
    token.address !== (t.token.contractAddress ?? 'native')
  )
    throw new Error('The wallet would send on another network. Send this deposit manually.');
  return w.transfer({ token, receiver: t.receiver, amount: BigInt(t.amount) });
}

const NO_GAS =
  /gas required exceeds|insufficient funds for (gas|rent|fee)|no record of a prior credit/i;
const NO_TOKEN =
  /exceeds balance|insufficient balance|custom program error: 0x1\b|insufficient funds/i;

/**
 * Why a wallet send threw. `declined`: the user said no (EIP-1193 4001, or the wallet's words). `no-gas`: the native
 * coin cannot pay the network fee; `no-token`: less of the token than the quote; `not-sent`: another revert at the gas
 * estimate. All of these come before any broadcast. `unknown`: anything else may come after it, so the dialog never
 * offers to send that quote again.
 */
export function sendFailure(e: unknown): SendFailure {
  if (typeof e !== 'object' || e === null) return 'unknown';
  const { code, message } = e as { code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (code === 4001 || /user (rejected|denied|cancel)|cancell?ed by user/i.test(text))
    return 'declined';
  if (NO_GAS.test(text)) return 'no-gas';
  if (NO_TOKEN.test(text)) return 'no-token';
  if (/execution reverted/i.test(text)) return 'not-sent';
  return 'unknown';
}

export async function disconnectOriginWallet(wallet: OriginWallet): Promise<void> {
  const k = await load();
  const w = k.wallets.find((x) => CHAIN_BY_TYPE[x.type] === wallet.chain);
  if (w) await k.disconnect(w);
}
