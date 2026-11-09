import 'server-only';
import { PUBLIC_DEMO } from './public-demo';

/**
 * Whether this dashboard may hand an assembled cascade to the connected wallet for the user to sign. Off unless
 * MAINNET_WALLET_SIGNING=1, and ALWAYS off on the public demo, whatever the environment says. A server component
 * reads this and passes it to the client; the client's single signing file (lib/wallet-sign.ts) also re-checks it.
 */
export function walletSigningEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (PUBLIC_DEMO || env['PUBLIC_DEMO'] === '1') return false;
  return env['MAINNET_WALLET_SIGNING'] === '1';
}
