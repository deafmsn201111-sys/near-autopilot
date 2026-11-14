'use client';
import type { HotKit } from '@hot-labs/kit';
import type { OmniWallet } from '@hot-labs/kit/core';

/**
 * ORIGIN-CHAIN WALLETS through HOT Kit (@hot-labs/kit): EVM and Solana only, for the deposit dialog. The NEAR wallet
 * stays in lib/wallet.ts; the kit's NEAR connector is left out because it shares near-connect's localStorage session.
 * The kit (and every chain SDK it pulls in) is imported on first use, never on page load. Nothing here signs or sends.
 */
export type OriginChain = 'evm' | 'solana';
export interface OriginWallet {
  chain: OriginChain;
  address: string;
}

// WalletType.EVM / WalletType.SOLANA, inlined so this module stays free of a runtime kit import.
const TYPE_BY_CHAIN: Record<OriginChain, number> = { evm: 1, solana: 1001 };
const CHAIN_BY_TYPE: Record<number, OriginChain> = { 1: 'evm', 1001: 'solana' };

let kit: Promise<HotKit> | null = null;
const listeners = new Set<(wallets: OriginWallet[]) => void>();

function load(): Promise<HotKit> {
  kit ??= (async () => {
    const [{ HotKit }, { lazyConnector }] = await Promise.all([
      import('@hot-labs/kit'),
      import('@hot-labs/kit/defaults'),
    ]);
    const k = new HotKit({
      connectors: [
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
      ],
    });
    const emit = () => {
      const now = originWallets(k.wallets);
      for (const l of listeners) l(now);
    };
    k.onConnect(emit);
    k.onDisconnect(emit);
    return k;
  })();
  kit.catch(() => {
    kit = null;
  });
  return kit;
}

function originWallets(wallets: OmniWallet[]): OriginWallet[] {
  return wallets.flatMap((w) => {
    const chain = CHAIN_BY_TYPE[w.type];
    return chain && w.address ? [{ chain, address: w.address }] : [];
  });
}

/** Calls `onChange` with the connected EVM / Solana wallets now and on every connect / disconnect. */
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
  const k = await load();
  try {
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
