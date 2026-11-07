'use client';
import { NearConnector } from '@hot-labs/near-connect';

/**
 * WALLET CONNECTION through HOT Connector (@hot-labs/near-connect): HOT, Meteor, Intear, MyNearWallet, Nightly,
 * NEAR Mobile, OKX and more, each wallet's code running in its own sandboxed iframe. Sign-in only.
 *
 * MAINNET SIGNING IS LOCKED BY ARCHITECTURE:
 *  - no limited-key sign-in option: connecting adds NO access key to the account (no state change), and only wallets
 *    that can sign in without adding a key are offered;
 *  - this module exposes only connect / disconnect / the account id. Nothing in the dashboard calls a wallet's
 *    transaction signing methods (sign-and-send, sign-transaction, delegate actions); a test
 *    (test/signing-lock.test.ts) fails if any source file calls one. Unlocking needs a code change, a review and the
 *    final security tests.
 */
export const MAINNET_SIGNING = 'locked' as const;

let connector: NearConnector | null = null;
const listeners = new Set<(accountId: string | null) => void>();
const emit = (id: string | null) => listeners.forEach((l) => l(id));

function get(): NearConnector {
  if (!connector) {
    connector = new NearConnector({
      network: 'mainnet',
      autoConnect: true,
      features: { signInWithoutAddKey: true },
    });
    connector.on('wallet:signIn', (t) => emit(t.accounts[0]?.accountId ?? null));
    connector.on('wallet:signOut', () => emit(null));
  }
  return connector;
}

async function current(): Promise<string | null> {
  try {
    const { accounts } = await get().getConnectedWallet();
    return accounts[0]?.accountId ?? null;
  } catch {
    return null; // nothing connected
  }
}

/** The connected account id, or null; `onChange` is called now and on every change. Returns an unsubscribe. */
export async function watchAccount(
  onChange: (accountId: string | null) => void,
): Promise<() => void> {
  listeners.add(onChange);
  onChange(await current());
  return () => listeners.delete(onChange);
}

export async function connect(): Promise<void> {
  await get().connect();
}

export async function disconnect(): Promise<void> {
  await get().disconnect();
  emit(null);
}
