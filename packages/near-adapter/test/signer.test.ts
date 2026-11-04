import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { KeyPairEd25519, PublicKey } from '@near-js/crypto';
import { encodeTransaction, SignedTransaction } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { describe, expect, it } from 'vitest';
import { accountId, type PlannedTransaction } from '@near-autopilot/core';
import { encodeUnsigned, NearKeyPairSigner, SignerConfigurationError } from '../src';

/** Every key here is generated at test time; no key material is committed. */
const ACCOUNT = accountId('signer-test.testnet');
const BLOCK_HASH = baseEncode(new Uint8Array(32).fill(7));
const plan: PlannedTransaction = {
  intentId: 'i1',
  signerId: ACCOUNT,
  receiverId: accountId('wrap.testnet'),
  actions: [
    {
      type: 'FunctionCall',
      methodName: 'storage_deposit',
      args: { account_id: ACCOUNT, registration_only: true },
      gas: 30_000_000_000_000n,
      deposit: 1_250_000_000_000_000_000_000n,
    },
  ],
};

const keyFile = (contents: unknown, mode = 0o600): string => {
  const dir = mkdtempSync(join(tmpdir(), 'signer-test-'));
  const path = join(dir, 'key.json');
  writeFileSync(path, JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
};

describe('NearKeyPairSigner', () => {
  it('signs exactly the planned transaction, and the signature verifies against the public key', async () => {
    const kp = KeyPairEd25519.fromRandom();
    const signer = NearKeyPairSigner.fromKeyPair(ACCOUNT, kp);
    const signed = await signer.sign(plan, { nonce: 42n, blockHash: BLOCK_HASH });

    const decoded = SignedTransaction.decode(Buffer.from(signed.payloadBase64, 'base64'));
    const tx = decoded.transaction;
    expect(tx.signerId).toBe(ACCOUNT);
    expect(tx.receiverId).toBe('wrap.testnet');
    expect(BigInt(tx.nonce)).toBe(42n);
    expect(baseEncode(Uint8Array.from(tx.blockHash))).toBe(BLOCK_HASH);
    expect(tx.actions).toHaveLength(1);
    const call = tx.actions[0]?.functionCall;
    expect(call?.methodName).toBe('storage_deposit');
    expect(BigInt(call?.gas ?? 0)).toBe(30_000_000_000_000n);
    expect(BigInt(call?.deposit ?? 0)).toBe(1_250_000_000_000_000_000_000n);
    expect(JSON.parse(Buffer.from(call?.args ?? []).toString('utf8'))).toEqual({
      account_id: ACCOUNT,
      registration_only: true,
    });

    // The hash is sha256 of the unsigned bytes, and the signature is over that hash.
    const { hash, bytes } = encodeUnsigned(
      plan,
      { nonce: 42n, blockHash: BLOCK_HASH },
      signer.publicKey,
    );
    expect(signed.hash).toBe(baseEncode(hash));
    // Byte-identical round trip: the signed payload carries exactly these fields and this public key.
    expect(Buffer.from(encodeTransaction(tx)).equals(Buffer.from(bytes))).toBe(true);
    const pk = PublicKey.fromString(signer.publicKey);
    const sig = decoded.signature.ed25519Signature?.data;
    expect(sig).toBeDefined();
    expect(pk.verify(hash, Uint8Array.from(sig ?? []))).toBe(true);
    expect(pk.verify(hash, new Uint8Array(64))).toBe(false);
    expect(baseDecode(signed.hash)).toHaveLength(32);
  });

  it('refuses to sign for another account', async () => {
    const signer = NearKeyPairSigner.fromKeyPair(
      accountId('other.testnet'),
      KeyPairEd25519.fromRandom(),
    );
    await expect(signer.sign(plan, { nonce: 1n, blockHash: BLOCK_HASH })).rejects.toThrow(
      'refusing to sign for signer-test.testnet',
    );
  });

  it('never exposes the secret through inspect, JSON or enumeration', () => {
    const kp = KeyPairEd25519.fromRandom();
    const secret = kp.toString();
    const signer = NearKeyPairSigner.fromKeyPair(ACCOUNT, kp);
    const views = [
      inspect(signer, { depth: 10 }),
      JSON.stringify(signer),
      String(Object.values(signer)),
    ];
    for (const view of views) {
      expect(view).not.toContain(secret.slice('ed25519:'.length));
      expect(view).not.toContain(baseEncode(kp.secretKey));
    }
  });

  describe('fromKeyFile', () => {
    const kp = KeyPairEd25519.fromRandom();
    const good = {
      account_id: ACCOUNT,
      public_key: kp.getPublicKey().toString(),
      private_key: kp.toString(),
    };

    it('loads a near-cli key file with mode 600', () => {
      const signer = NearKeyPairSigner.fromKeyFile(keyFile(good), ACCOUNT);
      expect(signer.publicKey).toBe(good.public_key);
    });

    it('refuses a group- or world-readable key file', () => {
      expect(() => NearKeyPairSigner.fromKeyFile(keyFile(good, 0o644), ACCOUNT)).toThrow(
        /readable by other users/,
      );
    });

    it('refuses a key file for another account', () => {
      expect(() =>
        NearKeyPairSigner.fromKeyFile(keyFile({ ...good, account_id: 'x.testnet' }), ACCOUNT),
      ).toThrow('key file is for x.testnet');
    });

    it('refuses a key file whose public key does not match its private key', () => {
      const other = KeyPairEd25519.fromRandom().getPublicKey().toString();
      expect(() =>
        NearKeyPairSigner.fromKeyFile(keyFile({ ...good, public_key: other }), ACCOUNT),
      ).toThrow('does not match');
    });

    it('never echoes key material in its errors', () => {
      const bad = { ...good, private_key: `ed25519:${'1'.repeat(10)}` };
      let message = '';
      try {
        NearKeyPairSigner.fromKeyFile(keyFile(bad), ACCOUNT);
      } catch (error) {
        expect(error).toBeInstanceOf(SignerConfigurationError);
        message = String(error);
      }
      expect(message).toMatch(/invalid ed25519 key/);
      expect(message).not.toContain('1111111111');
      expect(() => NearKeyPairSigner.fromKeyFile('/nonexistent/key.json', ACCOUNT)).toThrow(
        'cannot read key file',
      );
    });
  });
});
