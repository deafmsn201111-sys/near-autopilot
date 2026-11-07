import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * MAINNET SIGNING IS LOCKED BY ARCHITECTURE. The dashboard may connect a wallet (sign-in only, no access key) but must
 * never ask it to sign anything. This test fails if any dashboard source calls a transaction-signing method of a wallet
 * or requests a function-call access key. Unlocking is a deliberate code change that removes this test.
 */
const ROOT = join(__dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === '.next' ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

describe('mainnet signing lock (dashboard)', () => {
  const sources = ['app', 'components', 'lib'].flatMap((d) => files(join(ROOT, d)));
  it('no source calls a wallet transaction-signing method or asks for an access key', () => {
    const forbidden =
      /\.(signAndSendTransactions?|signTransactions?|signDelegateActions?)\s*\(|createAccessKeyFor|contractId\s*:/;
    const hits = sources.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
  it('the wallet module declares the lock', () => {
    expect(readFileSync(join(ROOT, 'lib/wallet.ts'), 'utf8')).toContain(
      "MAINNET_SIGNING = 'locked'",
    );
  });
});
