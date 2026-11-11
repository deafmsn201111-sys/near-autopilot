/**
 * NEP-413 ownership proof: the wallet signs a fixed off-chain message (no transaction, no gas). The server rebuilds
 * the same message from the account id, so a signature over any other text never verifies.
 */
export const OWNERSHIP_RECIPIENT = 'near-autopilot.tech';
export const OWNERSHIP_TTL_MS = 24 * 60 * 60 * 1000;
export const OWNERSHIP_COOKIE = 'np_owner';

export const ownershipMessage = (accountId: string) =>
  `NEAR Autopilot: I own ${accountId} and ask for an AI analysis of it. This is not a transaction.`;

/** 32-byte nonce: the signing time (ms, big-endian u64) followed by 24 random bytes. */
export function ownershipNonce(nowMs: number, random: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(32);
  new DataView(nonce.buffer).setBigUint64(0, BigInt(nowMs));
  nonce.set(random.subarray(0, 24), 8);
  return nonce;
}

export const nonceTimeMs = (nonce: Uint8Array) =>
  Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0));

export interface OwnershipProof {
  readonly accountId: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly nonce: string;
}
