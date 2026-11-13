'use client';
import { NearConnector } from '@hot-labs/near-connect';

/**
 * WALLET CONNECTION through HOT Connector (@hot-labs/near-connect): HOT, Meteor, Intear, MyNearWallet, Nightly,
 * NEAR Mobile, OKX and more, each wallet's code running in its own sandboxed iframe. Connecting adds NO access key
 * to the account (`signInWithoutAddKey`): no key ever reaches the server or this dashboard.
 *
 * ONE-CLICK SIGNING IS OWNER-WALLET-ONLY:
 *  - the ONLY place that asks a wallet to sign is `lib/wallet-sign.ts`; a test (test/signing-lock.test.ts) fails if
 *    any OTHER source file calls a wallet's transaction-signing method or asks for a function-call access key;
 *  - signing is behind the MAINNET_WALLET_SIGNING flag; the user signs their own account's cascade in
 *    their own wallet, which shows every action again for approval. The server holds no key and sends nothing.
 */
export const MAINNET_SIGNING = 'owner-wallet-only' as const;

let connector: NearConnector | null = null;
const listeners = new Set<(accountId: string | null) => void>();
let accountEventVersion = 0;
const emit = (id: string | null) => {
  accountEventVersion += 1;
  for (const l of listeners) l(id);
};

function get(): NearConnector {
  if (!connector) {
    connector = new NearConnector({
      network: 'mainnet',
      autoConnect: true,
      features: { signInWithoutAddKey: true },
      cspNonce: document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined,
    });
    connector.on('wallet:signIn', (t) => emit(t.accounts[0]?.accountId ?? null));
    connector.on('wallet:signOut', () => emit(null));
  }
  return connector;
}

/** The account of the connected wallet, read from the wallet itself; null when none is connected. */
export async function currentAccount(): Promise<string | null> {
  try {
    const { accounts } = await get().getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null; // nothing connected
  }
}

/** Calls `onChange` now and on every sign-in / sign-out. Returns an unsubscribe function. */
export function watchAccount(onChange: (accountId: string | null) => void): () => void {
  listeners.add(onChange);
  // A sign-in/sign-out event can arrive while the initial wallet query is pending. Do not let
  // that older query overwrite the newer event (most visibly, a connected wallet with a stale null).
  const versionAtStart = accountEventVersion;
  void currentAccount().then((id) => {
    if (versionAtStart === accountEventVersion) onChange(id);
  });
  return () => {
    listeners.delete(onChange);
  };
}

/**
 * Opens the wallet list and signs in. Resolves with the signed-in account id, read from the wallet the user picked
 * (not from an event, so it is the same on the first and on every later connection); null if closed or failed.
 */
export async function connect(): Promise<string | null> {
  const wallet = await get().connect();
  const accounts = await wallet.getAccounts();
  return accounts[0]?.accountId ?? null;
}

/** The wallet the user connected (for lib/wallet-sign.ts only); throws when none is connected. */
export async function connectedWallet() {
  return (await get().getConnectedWallet()).wallet;
}

export async function disconnect(): Promise<void> {
  try {
    await get().disconnect();
  } finally {
    emit(null);
  }
}
