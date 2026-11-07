'use client';
import { setupWalletSelector, type WalletSelector } from '@near-wallet-selector/core';
import { setupHotWallet } from '@near-wallet-selector/hot-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupModal, type WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';

/**
 * WALLET CONNECTION, sign-in only. MAINNET SIGNING IS LOCKED BY ARCHITECTURE:
 *  - no access-key request and no contract id: signing in adds NO access key to the account (no state change);
 *  - this module exposes only connect / disconnect / the account id. Nothing in the dashboard calls a wallet's
 *    transaction signing methods (sign-and-send, sign-transaction, delegate actions); a test (test/signing-lock.test.ts)
 *    fails if any source file calls one. Unlocking needs a code change, a review and the final security tests.
 */
export const MAINNET_SIGNING = 'locked' as const;

let ready: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

function init() {
  ready ??= setupWalletSelector({
    network: 'mainnet',
    modules: [setupHotWallet(), setupMeteorWallet(), setupIntearWallet(), setupMyNearWallet()],
  }).then((selector) => ({
    selector,
    modal: setupModal(selector, {
      description:
        'Sign in to view your portfolio. NEAR Autopilot never asks your wallet to sign a transaction.',
    }),
  }));
  return ready;
}

/** The signed-in account id, or null; `onChange` is called on every change. Returns an unsubscribe function. */
export async function watchAccount(
  onChange: (accountId: string | null) => void,
): Promise<() => void> {
  const { selector } = await init();
  const pick = () => selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
  onChange(pick());
  const sub = selector.store.observable.subscribe(() => onChange(pick()));
  return () => sub.unsubscribe();
}

export async function connect(): Promise<void> {
  (await init()).modal.show();
}

export async function disconnect(): Promise<void> {
  const { selector } = await init();
  if (!selector.isSignedIn()) return;
  await (await selector.wallet()).signOut();
}
