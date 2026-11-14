'use client';
import { loadKit, NEAR_WALLET_TYPE, type NearSignIn } from './hot-kit';

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
const SESSION_KEY = 'selected-wallet';
function hasSession(): boolean {
  try {
    return localStorage.getItem(SESSION_KEY) !== null;
  } catch {
    return false;
  }
}

// near-connect writes the key before the wallet's sign-in and keeps it when that sign-in is cancelled. While a
// connect() still waits for a sign-in, an empty account list only means the wallet has not answered yet.
function forgetCancelledSignIn(e: unknown) {
  if (waiting > 0 || !(e instanceof Error) || e.message !== 'No accounts found') return;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage blocked: hasSession() is false anyway
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
  } catch (e) {
    forgetCancelledSignIn(e);
    return null;
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
 * account. A NEAR sign-in still pending in its wallet when the list closed goes to `onLateSignIn` once it lands,
 * unless another click came first.
 */
let attempt = 0;
let waiting = 0;
let dropLate: () => void = () => undefined;
export async function connect(
  onLateSignIn: (accountId: string) => void = () => undefined,
): Promise<string | null> {
  const mine = ++attempt;
  dropLate();
  const { kit, near: connector } = await near();
  let onSignIn: (t: NearSignIn) => void = () => undefined;
  const signedIn = new Promise<string | null>((resolve) => {
    onSignIn = (t) => resolve(t.accounts[0]?.accountId ?? null);
    connector.on('wallet:signIn', onSignIn);
  });
  waiting++;
  let listening = true;
  const stop = () => {
    if (!listening) return;
    listening = false;
    waiting--;
    connector.off('wallet:signIn', onSignIn);
  };
  let closed = false;
  const picked = kit.connect().then(
    (w) => (Number(w.type) === NEAR_WALLET_TYPE ? w.address : null),
    () => {
      closed = true;
      return null;
    },
  );
  const id = await Promise.race([signedIn, picked]);
  if (id === null && closed && mine === attempt) {
    dropLate = stop;
    void signedIn.then((late) => {
      stop();
      if (late && mine === attempt) onLateSignIn(late);
    });
    return null;
  }
  stop();
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
    await kit.requestConnectors();
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
