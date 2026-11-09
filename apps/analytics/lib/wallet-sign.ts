'use client';
import { connectedWallet, currentAccount } from './wallet';
import type { PreparedTransaction } from './prepare-types';

/**
 * THE ONLY PLACE THE DASHBOARD ASKS A WALLET TO SIGN (test/signing-lock.test.ts enforces it). It signs exactly the
 * cascade the analytics API assembled — the same transactions shown in the preview — and nothing else:
 *  - only when signing is enabled here (a flag, never on the public demo); otherwise the UI never calls this;
 *  - only from the account the cascade is for: a wallet connected to another account is refused before it opens;
 *  - only function calls, on NEAR mainnet.
 * The wallet shows every action again and the user approves or declines it there. The server holds no key: it only
 * assembled the transactions. Each step is signed in order (a later step may depend on an earlier one landing).
 */

export interface SignResult {
  readonly ok: boolean;
  /** Transaction hashes of the steps that were signed and sent, in order. */
  readonly hashes: readonly string[];
  /** Present when the run stopped early (declined or failed); the already-sent `hashes` still stand. */
  readonly reason?: string;
}

function toConnectorActions(tx: PreparedTransaction) {
  return tx.actions.map((a) => ({
    type: 'FunctionCall' as const,
    params: {
      methodName: a.methodName,
      args: a.args,
      gas: a.gas,
      deposit: a.deposit,
    },
  }));
}

/**
 * Sign and send an assembled cascade for `signerId`. Returns the hashes sent so far and, if it stopped early, why.
 * `enabled` is the dashboard's signing flag; the caller passes it so this file is the single gate the lock test knows.
 */
export async function signCascade(
  transactions: readonly PreparedTransaction[],
  signerId: string,
  enabled: boolean,
): Promise<SignResult> {
  if (!enabled) return { ok: false, hashes: [], reason: 'Wallet signing is not enabled here.' };
  if (transactions.length === 0) return { ok: false, hashes: [], reason: 'Nothing to sign.' };
  if (transactions.some((t) => t.actions.length === 0))
    return { ok: false, hashes: [], reason: 'A step has no actions.' };

  const account = await currentAccount();
  if (account !== signerId)
    return {
      ok: false,
      hashes: [],
      reason: `Connect the wallet of ${signerId} first${account ? ` (connected: ${account})` : ''}.`,
    };

  const hashes: string[] = [];
  try {
    const wallet = await connectedWallet();
    for (const tx of transactions) {
      const outcome = await wallet.signAndSendTransaction({
        network: 'mainnet',
        signerId,
        receiverId: tx.receiverId,
        actions: toConnectorActions(tx),
      });
      const hash: unknown = outcome?.transaction_outcome?.id;
      if (typeof hash !== 'string' || !hash)
        return { ok: false, hashes, reason: 'The wallet did not return a transaction hash.' };
      hashes.push(hash);
    }
    return { ok: true, hashes };
  } catch (e) {
    return { ok: false, hashes, reason: e instanceof Error ? e.message : String(e) };
  }
}
