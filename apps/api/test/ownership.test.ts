import { KeyPairEd25519 } from '@near-js/crypto';
import { baseEncode } from '@near-js/utils';
import { describe, expect, it } from 'vitest';
import { RpcError } from '@near-autopilot/core';
import { OWNERSHIP_TTL_MS } from '@near-autopilot/core/ownership';
import { verifyOwnership } from '../src/wallet/ownership';
import { signOwnership } from './support/nep413';

const NOW = Date.UTC(2026, 10, 11, 12);
const key = KeyPairEd25519.fromRandom();
const owner = 'alice.near';

const sign = (
  over: Partial<{ message: string; recipient: string; at: number; signer: KeyPairEd25519 }> = {},
) => signOwnership({ account: owner, signer: key, at: NOW, ...over });

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

  it('also reads an unpadded base64url signature', async () => {
    const proof = await sign();
    const signature = Buffer.from(proof.signature, 'base64').toString('base64url');
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

  it('rejects malformed input and an access-key read that fails for good', async () => {
    expect(await verifyOwnership(null, owner, deps)).toBe(false);
    expect(await verifyOwnership({ ...(await sign()), nonce: 'AAAA' }, owner, deps)).toBe(false);
    const failing = {
      ...deps,
      isFullAccessKey: () => Promise.reject(new Error('rpc down')),
    };
    expect(await verifyOwnership(await sign(), owner, failing)).toBe(false);
  });

  it('a key read that could not run is not an answer: it throws instead of saying "not the owner"', async () => {
    const flaky = {
      ...deps,
      isFullAccessKey: () =>
        Promise.reject(new RpcError('RPC query timed out', true, { kind: 'timeout' })),
    };
    await expect(verifyOwnership(await sign(), owner, flaky)).rejects.toThrow('timed out');
    const rejectedKey = {
      ...deps,
      isFullAccessKey: () =>
        Promise.reject(new RpcError('RPC query returned HTTP 403', false, { kind: 'http_error' })),
    };
    await expect(verifyOwnership(await sign(), owner, rejectedKey)).rejects.toThrow('403');
  });

  it('a key the node does not know is "not the owner"', async () => {
    const unknownKey = {
      ...deps,
      isFullAccessKey: () =>
        Promise.reject(new RpcError('RPC query failed: UNKNOWN_ACCESS_KEY', false)),
    };
    expect(await verifyOwnership(await sign(), owner, unknownKey)).toBe(false);
  });
});
