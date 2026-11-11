import 'server-only';

/**
 * Whether this dashboard may hand an assembled cascade to the connected wallet for the user to sign. Off unless
 * MAINNET_WALLET_SIGNING=1. A server component reads this and passes it to the client; the client's single signing
 * file (lib/wallet-sign.ts) also re-checks it.
 */
export function walletSigningEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env['MAINNET_WALLET_SIGNING'] === '1';
}
