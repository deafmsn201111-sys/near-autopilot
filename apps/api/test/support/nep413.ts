import { randomBytes } from 'node:crypto';
import type { KeyPairEd25519 } from '@near-js/crypto';
import { serialize } from 'borsh';
import {
  OWNERSHIP_RECIPIENT,
  ownershipMessage,
  ownershipNonce,
} from '@near-autopilot/core/ownership';

const NEP413_TAG = 2 ** 31 + 413;
const payloadSchema = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' },
  },
} as const;

/** Signs exactly as a NEP-413 wallet does, with near-js + borsh, independent of the code under test. */
export async function signOwnership(args: {
  readonly account: string;
  readonly signer: KeyPairEd25519;
  readonly at: number;
  readonly message?: string;
  readonly recipient?: string;
}) {
  const nonce = ownershipNonce(args.at, randomBytes(24));
  const payload = serialize(payloadSchema, {
    message: args.message ?? ownershipMessage(args.account),
    nonce: Array.from(nonce),
    recipient: args.recipient ?? OWNERSHIP_RECIPIENT,
    callbackUrl: null,
  });
  const tag = serialize('u32', NEP413_TAG);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array([...tag, ...payload])),
  );
  return {
    accountId: args.account,
    publicKey: args.signer.getPublicKey().toString(),
    signature: Buffer.from(args.signer.sign(hash).signature).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  };
}
