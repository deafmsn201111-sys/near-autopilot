'use client';
import { loadKit, NEAR_WALLET_TYPE } from './hot-kit';

/**
 * WALLET CONNECTION through the one HOT Kit (lib/hot-kit.ts): its picker connects the NEAR account (HOT, Meteor,
 * Intear, MyNearWallet, Nightly, NEAR Mobile, OKX and more, each in its own sandboxed iframe) and, in the same list,
 * EVM and Solana wallets for the deposit dialog. Connecting adds NO access key to the account (`signInWithoutAddKey`):
 * no key ever reaches the server or this dashboard.
 *
 * ONE-CLICK SIGNING IS OWNER-WALLET-ONLY:
 *  - the ONLY place that asks a wallet to sign is `lib/wallet-sign.ts`; a test (test/signing-lock.test.ts) fails if
 *    any OTHER source file calls a wallet's transaction-signing method or asks for a function-call access key;
 *  - signing is behind the MAINNET_WALLET_SIGNING flag; the user signs their own account's cascade in
 *    their own wallet, which shows every action again for approval. The server holds no key and sends nothing.
 */
export const MAINNET_SIGNING = 'owner-wallet-only' as const;

const listeners = new Set<(accountId: string | null) => void>();
const emit = (id: string | null) => {
  for (const l of listeners) l(id);
};

// near-connect's session key: without it there is nothing to restore, so the kit is not loaded on page load.
function hasSession(): boolean {
  try {
    return localStorage.getItem('selected-wallet') !== null;
  } catch {
    return false;
  }
}

let subscribed: Promise<Awaited<ReturnType<typeof loadKit>>> | null = null;
function near() {
  subscribed ??= loadKit().then((loaded) => {
    loaded.near.on('wallet:signIn', (t) => emit(t.accounts[0]?.accountId ?? null));
    loaded.near.on('wallet:signOut', () => emit(null));
    return loaded;
  });
  return subscribed.catch((e: unknown) => {
    subscribed = null;
    throw e;
  });
}

/** The account of the connected wallet, read from the wallet itself; null when none is connected. */
export async function currentAccount(): Promise<string | null> {
  if (!subscribed && !hasSession()) return null;
  try {
    const { accounts } = await (await near()).near.getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null; // nothing connected
  }
}

/** Calls `onChange` now and on every sign-in / sign-out. Returns an unsubscribe function. */
export function watchAccount(onChange: (accountId: string | null) => void): () => void {
  listeners.add(onChange);
  void currentAccount().then((id) => listeners.has(onChange) && onChange(id));
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Opens the kit's wallet list (NEAR, EVM, Solana). Resolves with the NEAR account signed in there; null when the list
 * was closed or only another chain's wallet was connected. A NEAR sign-in also settles it: in kit 2.0.0 the list may
 * never settle after its nested chain list is closed, so a later click opens it again; only the latest click gets the
 * account.
 */
let attempt = 0;
export async function connect(): Promise<string | null> {
  const mine = ++attempt;
  const { kit, near: connector } = await near();
  const signedIn = new Promise<string | null>((resolve) =>
    connector.once('wallet:signIn', (t) => resolve(t.accounts[0]?.accountId ?? null)),
  );
  const picked = kit.connect().then(
    (w) => (Number(w.type) === NEAR_WALLET_TYPE ? w.address : null),
    () => null,
  );
  const id = await Promise.race([signedIn, picked]);
  return mine === attempt ? id : null;
}

/** The wallet the user connected (for lib/wallet-sign.ts only); throws when none is connected. */
export async function connectedWallet() {
  return (await (await near()).near.getConnectedWallet()).wallet;
}

/** Signs out of every connected wallet: NEAR and the EVM / Solana ones. */
export async function disconnect(): Promise<void> {
  try {
    if (!subscribed && !hasSession()) return;
    const { kit, near: connector } = await near();
    // The NEAR sign-out goes to near-connect itself: the kit's NEAR connector does not await it.
    await Promise.allSettled([
      connector.disconnect(),
      ...kit.wallets
        .filter((w) => Number(w.type) !== NEAR_WALLET_TYPE)
        .map((w) => kit.disconnect(w)),
    ]);
  } finally {
    emit(null);
  }
}
