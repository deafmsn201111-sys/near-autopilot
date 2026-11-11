import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  OWNERSHIP_RECIPIENT,
  OWNERSHIP_TTL_MS,
  nonceTimeMs,
  ownershipMessage,
} from '@near-autopilot/core/ownership';
import { z } from 'zod';

const NEP413_TAG = 2 ** 31 + 413;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const proofSchema = z.object({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  signature: z.string().base64(),
  nonce: z.string().base64(),
});

export interface OwnershipDeps {
  now(): number;
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
}

function base58Key(s: string): Buffer {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BASE58.indexOf(c));
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
}

const borshString = (s: string) => {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

function nep413Hash(message: string, nonce: Buffer, recipient: string): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const noCallbackUrl = Buffer.from([0]);
  return createHash('sha256')
    .update(
      Buffer.concat([tag, borshString(message), nonce, borshString(recipient), noCallbackUrl]),
    )
    .digest();
}

/** The proof travels as base64url JSON in this header (the UI keeps it in a session cookie). */
export const OWNERSHIP_HEADER = 'x-ownership-proof';

export function proofFromHeader(header: string | string[] | undefined): unknown {
  if (typeof header !== 'string' || header.length > 1024) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * True only when `raw` is a fresh NEP-413 signature of our fixed message for `accountId`, made by one of the
 * account's full-access keys. Anything else, including a failed key read, is false: the caller falls back to
 * heuristics.
 */
export async function verifyOwnership(
  raw: unknown,
  accountId: string,
  deps: OwnershipDeps,
): Promise<boolean> {
  return check(raw, accountId, deps).catch(() => false);
}

async function check(raw: unknown, accountId: string, deps: OwnershipDeps): Promise<boolean> {
  const parsed = proofSchema.safeParse(raw);
  if (!parsed.success || parsed.data.accountId !== accountId) return false;
  const { publicKey, signature, nonce: nonceB64 } = parsed.data;
  const nonce = Buffer.from(nonceB64, 'base64');
  const key = base58Key(publicKey.slice('ed25519:'.length));
  const sig = Buffer.from(signature, 'base64');
  if (nonce.length !== 32 || key.length !== 32 || sig.length !== 64) return false;

  const signedAt = nonceTimeMs(nonce);
  const now = deps.now();
  if (signedAt < now - OWNERSHIP_TTL_MS || signedAt > now + CLOCK_SKEW_MS) return false;

  const hash = nep413Hash(ownershipMessage(accountId), nonce, OWNERSHIP_RECIPIENT);
  const spki = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, hash, spki, sig)) return false;

  return deps.isFullAccessKey(accountId, publicKey);
}
