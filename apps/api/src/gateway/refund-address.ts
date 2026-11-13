import { createHash } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { base58, bech32, bech32m, createBase58check } from '@scure/base';

/** 1Click `blockchain` ids a deposit may come from. No memo chains. */
export const DEPOSIT_CHAINS = ['eth', 'base', 'arb', 'sol', 'btc'] as const;
export type DepositChain = (typeof DEPOSIT_CHAINS)[number];

const sha256 = (d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest());
const base58check = createBase58check(sha256);
const BTC_P2PKH = 0x00;
const BTC_P2SH = 0x05;

const attempt = (f: () => boolean) => {
  try {
    return f();
  } catch {
    return false;
  }
};

function isBtcBase58(address: string): boolean {
  const payload = base58check.decode(address);
  return payload.length === 21 && (payload[0] === BTC_P2PKH || payload[0] === BTC_P2SH);
}

// BIP-173 / BIP-350: witness v0 uses bech32 with a 20- or 32-byte program, v1..16 use bech32m with 2..40 bytes.
function isBtcSegwit(address: string): boolean {
  const v0 = attempt(() => {
    const { prefix, words } = bech32.decode(address as `${string}1${string}`);
    const program = bech32.fromWords(words.slice(1));
    return prefix === 'bc' && words[0] === 0 && (program.length === 20 || program.length === 32);
  });
  if (v0) return true;
  return attempt(() => {
    const { prefix, words } = bech32m.decode(address as `${string}1${string}`);
    const version = words[0] ?? -1;
    const program = bech32m.fromWords(words.slice(1));
    return (
      prefix === 'bc' &&
      version >= 1 &&
      version <= 16 &&
      program.length >= 2 &&
      program.length <= 40
    );
  });
}

// EIP-55: a mixed-case address carries a checksum in its letter case; all-lower or all-upper carries none.
function isEvm(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = Buffer.from(keccak_256(hex.toLowerCase())).toString('hex');
  return [...hex].every((c, i) =>
    /\d/.test(c) ? true : parseInt(hash[i] ?? '0', 16) >= 8 === (c === c.toUpperCase()),
  );
}

/** Whether `address` is a mainnet address of `chain` that 1Click can refund to. Format and checksum only. */
export function isRefundAddress(chain: DepositChain, address: string): boolean {
  switch (chain) {
    case 'eth':
    case 'base':
    case 'arb':
      return isEvm(address);
    case 'sol':
      return attempt(() => base58.decode(address).length === 32);
    case 'btc':
      return attempt(() => isBtcBase58(address)) || isBtcSegwit(address);
  }
}
