import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE-CLICK SIGNING IS OWNER-WALLET-ONLY AND LIVES IN EXACTLY ONE FILE. The dashboard may ask the connected wallet to
 * sign — but only `lib/wallet-sign.ts` may do it. This test fails if ANY OTHER dashboard source calls a wallet's
 * transaction-signing method or asks for a function-call access key, so the signing surface stays auditable in one place.
 */
const ROOT = join(__dirname, '..');
/** The single file allowed to call a wallet signing method. */
const SIGNING_FILE = join(ROOT, 'lib', 'wallet-sign.ts');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'node_modules' || f === '.next' ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

describe('one-click signing lock (dashboard)', () => {
  const sources = ['app', 'components', 'lib']
    .flatMap((d) => files(join(ROOT, d)))
    .filter((f) => f !== SIGNING_FILE);

  it('no source OTHER THAN lib/wallet-sign.ts signs or asks for an access key', () => {
    const forbidden =
      /\.(signAndSendTransactions?|signTransactions?|signDelegateActions?)\s*\(|createAccessKeyFor|contractId\s*:/;
    const hits = sources.filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('only lib/hot-kit.ts asks an origin-chain wallet to send, and only through transfer (D34)', () => {
    const HOT_KIT = join(ROOT, 'lib', 'hot-kit.ts');
    const send = /\.(transfer|sendTransaction|signIntents)\s*\(/;
    const hits = sources.filter((f) => f !== HOT_KIT && send.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
    const calls = readFileSync(HOT_KIT, 'utf8').match(new RegExp(send, 'g'));
    expect(calls).toEqual(['.transfer(']);
  });

  it('the one signing file exists and declares its single-gate role', () => {
    const src = readFileSync(SIGNING_FILE, 'utf8');
    expect(src).toContain('THE ONLY PLACE THE DASHBOARD ASKS A WALLET TO SIGN');
    expect(src).toMatch(/\.signAndSendTransaction\s*\(/);
  });

  it('the wallet module declares the owner-wallet-only policy', () => {
    expect(readFileSync(join(ROOT, 'lib/wallet.ts'), 'utf8')).toContain(
      "MAINNET_SIGNING = 'owner-wallet-only'",
    );
  });
});
