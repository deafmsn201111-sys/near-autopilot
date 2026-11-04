import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { KeyPair, KeyType, PublicKey, type KeyPairString } from '@near-js/crypto';
import {
  actionCreators,
  createTransaction,
  encodeTransaction,
  Signature,
  SignedTransaction as NearSignedTransaction,
  type Transaction,
} from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import type {
  AccountId,
  ChainContext,
  PlannedTransaction,
  SignedTransaction,
  TransactionSigner,
} from '@near-autopilot/core';
import { z } from 'zod';

/** The JSON key-file format near-cli writes (`~/.near-credentials/<network>/<account>.json`). */
const keyFileSchema = z
  .object({
    account_id: z.string().min(2),
    public_key: z.string().startsWith('ed25519:'),
    private_key: z.string().startsWith('ed25519:').optional(),
    secret_key: z.string().startsWith('ed25519:').optional(),
  })
  .passthrough()
  .refine((k) => (k.private_key ?? k.secret_key) !== undefined, 'no private_key');

export class SignerConfigurationError extends Error {}

/**
 * Builds the borsh-encoded, unsigned NEAR transaction for a plan. Exposed so a preview can show and hash exactly the
 * bytes that would be signed.
 */
export function encodeUnsigned(
  tx: PlannedTransaction,
  context: ChainContext,
  publicKey: string,
): { transaction: Transaction; bytes: Uint8Array; hash: Uint8Array } {
  const transaction = createTransaction(
    tx.signerId,
    PublicKey.fromString(publicKey),
    tx.receiverId,
    context.nonce,
    tx.actions.map((a) => actionCreators.functionCall(a.methodName, a.args, a.gas, a.deposit)),
    baseDecode(context.blockHash),
  );
  const bytes = encodeTransaction(transaction);
  return { transaction, bytes, hash: new Uint8Array(createHash('sha256').update(bytes).digest()) };
}

const isKeyPairString = (s: string): s is KeyPairString =>
  s.startsWith('ed25519:') || s.startsWith('secp256k1:');

/**
 * Key pairs live here, not on the signer object, so util.inspect / console.log / structuredClone of a signer can never
 * reach the secret.
 */
const KEYS = new WeakMap<NearKeyPairSigner, KeyPair>();

/**
 * ed25519 signer over a key file kept OUTSIDE the repository. TESTNET use only: the composition root refuses to build
 * one for any other network. The private key lives only inside the @near-js KeyPair; nothing here exposes, logs or
 * serialises it.
 */
export class NearKeyPairSigner implements TransactionSigner {
  private constructor(
    readonly accountId: AccountId,
    readonly publicKey: string,
    keyPair: KeyPair,
  ) {
    KEYS.set(this, keyPair);
  }

  /**
   * @throws SignerConfigurationError if the file is unreadable, group/world-readable, malformed, for another account,
   *   or its public key does not match its private key.
   */
  static fromKeyFile(path: string, expectedAccount: AccountId): NearKeyPairSigner {
    let text: string;
    try {
      const mode = statSync(path).mode;
      if ((mode & 0o077) !== 0) {
        throw new SignerConfigurationError(
          `key file ${path} is readable by other users; run: chmod 600 "${path}"`,
        );
      }
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if (error instanceof SignerConfigurationError) throw error;
      throw new SignerConfigurationError(`cannot read key file ${path}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SignerConfigurationError(`key file ${path} is not JSON`);
    }
    const parsed = keyFileSchema.safeParse(json);
    // Never echo the file or zod's issue values: they could contain the key.
    if (!parsed.success)
      throw new SignerConfigurationError(`key file ${path} has an unexpected format`);
    if (parsed.data.account_id !== expectedAccount) {
      throw new SignerConfigurationError(
        `key file is for ${parsed.data.account_id}, expected ${expectedAccount}`,
      );
    }
    const secret = parsed.data.private_key ?? parsed.data.secret_key ?? '';
    let keyPair: KeyPair;
    try {
      if (!isKeyPairString(secret)) throw new Error('not a key string');
      keyPair = KeyPair.fromString(secret);
    } catch {
      throw new SignerConfigurationError(`key file ${path} holds an invalid ed25519 key`);
    }
    const derived = keyPair.getPublicKey().toString();
    if (derived !== parsed.data.public_key) {
      throw new SignerConfigurationError('key file public_key does not match its private key');
    }
    return new NearKeyPairSigner(expectedAccount, derived, keyPair);
  }

  /** Test seam: wrap an in-memory key pair (tests generate a random one; no key is ever committed). */
  static fromKeyPair(accountId: AccountId, keyPair: KeyPair): NearKeyPairSigner {
    return new NearKeyPairSigner(accountId, keyPair.getPublicKey().toString(), keyPair);
  }

  async sign(tx: PlannedTransaction, context: ChainContext): Promise<SignedTransaction> {
    if (tx.signerId !== this.accountId) {
      throw new SignerConfigurationError(
        `refusing to sign for ${tx.signerId}: this signer is ${this.accountId}`,
      );
    }
    const keyPair = KEYS.get(this);
    if (!keyPair) throw new SignerConfigurationError('signer has no key');
    const { transaction, hash } = encodeUnsigned(tx, context, this.publicKey);
    const { signature } = keyPair.sign(hash);
    const signed = new NearSignedTransaction({
      transaction,
      signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
    });
    return {
      hash: baseEncode(hash),
      payloadBase64: Buffer.from(signed.encode()).toString('base64'),
    };
  }

  /** JSON logging shows only public identity (the key is not on the instance anyway). */
  toJSON(): { accountId: string; publicKey: string } {
    return { accountId: this.accountId, publicKey: this.publicKey };
  }
}
