import { randomBytes } from 'node:crypto';
import { KeyPairEd25519 } from '@near-js/crypto';
import { baseEncode } from '@near-js/utils';
import { serialize } from 'borsh';
import { describe, expect, it } from 'vitest';
import {
  OWNERSHIP_RECIPIENT,
  OWNERSHIP_TTL_MS,
  ownershipMessage,
  ownershipNonce,
} from '@near-autopilot/core/ownership';
import { verifyOwnership } from '../src/wallet/ownership';

const NEP413_TAG = 2 ** 31 + 413;
const payloadSchema = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' },
  },
} as const;

const NOW = Date.UTC(2026, 10, 11, 12);
const key = KeyPairEd25519.fromRandom();
const owner = 'alice.near';

/** Signs exactly as a NEP-413 wallet does, with near-js + borsh, independent of the code under test. */
async function sign(
  over: Partial<{ message: string; recipient: string; at: number; signer: KeyPairEd25519 }> = {},
) {
  const signer = over.signer ?? key;
  const nonce = ownershipNonce(over.at ?? NOW, randomBytes(24));
  const payload = serialize(payloadSchema, {
    message: over.message ?? ownershipMessage(owner),
    nonce: Array.from(nonce),
    recipient: over.recipient ?? OWNERSHIP_RECIPIENT,
    callbackUrl: null,
  });
  const tag = serialize('u32', NEP413_TAG);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array([...tag, ...payload])),
  );
  return {
    accountId: owner,
    publicKey: signer.getPublicKey().toString(),
    signature: Buffer.from(signer.sign(hash).signature).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}

const fullAccess = new Map([[owner, key.getPublicKey().toString()]]);
const deps = {
  now: () => NOW,
  isFullAccessKey: async (account: string, publicKey: string) =>
    fullAccess.get(account) === publicKey,
};

describe('NEP-413 ownership proof', () => {
  it('accepts a fresh signature by a full-access key of the account', async () => {
    expect(await verifyOwnership(await sign(), owner, deps)).toBe(true);
  });

  it('also reads a signature encoded as ed25519:<base58>', async () => {
    const proof = await sign();
    const bytes = Buffer.from(proof.signature, 'base64');
    const signature = `ed25519:${baseEncode(bytes)}`;
    expect(await verifyOwnership({ ...proof, signature }, owner, deps)).toBe(true);
  });

  it('rejects a proof for another account than the one requested', async () => {
    expect(await verifyOwnership(await sign(), 'bob.near', deps)).toBe(false);
  });

  it('rejects a signature over a different message or recipient', async () => {
    expect(await verifyOwnership(await sign({ message: 'hello' }), owner, deps)).toBe(false);
    expect(await verifyOwnership(await sign({ recipient: 'evil.app' }), owner, deps)).toBe(false);
  });

  it('rejects a key that is not a full-access key of the account', async () => {
    const other = KeyPairEd25519.fromRandom();
    expect(await verifyOwnership(await sign({ signer: other }), owner, deps)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    const proof = await sign();
    const sig = Buffer.from(proof.signature, 'base64');
    sig[0] = (sig[0] ?? 0) ^ 1;
    expect(
      await verifyOwnership({ ...proof, signature: sig.toString('base64') }, owner, deps),
    ).toBe(false);
  });

  it('rejects a proof older than the TTL or signed in the future', async () => {
    const old = await sign({ at: NOW - OWNERSHIP_TTL_MS - 1 });
    const future = await sign({ at: NOW + 10 * 60 * 1000 });
    expect(await verifyOwnership(old, owner, deps)).toBe(false);
    expect(await verifyOwnership(future, owner, deps)).toBe(false);
  });

  it('rejects malformed input and an access-key read that fails', async () => {
    expect(await verifyOwnership(null, owner, deps)).toBe(false);
    expect(await verifyOwnership({ ...(await sign()), nonce: 'AAAA' }, owner, deps)).toBe(false);
    const failing = {
      ...deps,
      isFullAccessKey: () => Promise.reject(new Error('rpc down')),
    };
    expect(await verifyOwnership(await sign(), owner, failing)).toBe(false);
  });
});
