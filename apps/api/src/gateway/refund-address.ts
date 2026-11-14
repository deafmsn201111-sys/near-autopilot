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

// BIP-173 / BIP-350: v0 (bech32) with a 20- or 32-byte program, v1 taproot (bech32m) with 32 bytes. Higher versions
// and other v1 lengths are valid encodings but not spendable outputs today, so a refund there would be lost.
function isBtcSegwit(address: string): boolean {
  const v0 = attempt(() => {
    const { prefix, words } = bech32.decode(address as `${string}1${string}`);
    const program = bech32.fromWords(words.slice(1));
    return prefix === 'bc' && words[0] === 0 && (program.length === 20 || program.length === 32);
  });
  return (
    v0 ||
    attempt(() => {
      const { prefix, words } = bech32m.decode(address as `${string}1${string}`);
      return prefix === 'bc' && words[0] === 1 && bech32m.fromWords(words.slice(1)).length === 32;
    })
  );
}

// EIP-55: a mixed-case address carries a checksum in its letter case; all-lower or all-upper carries none.
function isEvm(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) return false;
  const hex = address.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  const hash = Buffer.from(keccak_256(hex.toLowerCase())).toString('hex');
  return [...hex].every((c, i) =>
    /\d/.test(c) ? true : parseInt(hash[i] ?? '0', 16) >= 8 === (c === c.toUpperCase()),
  );
}

/** Whether `address` is a mainnet address of `chain` that 1Click can refund to. Format, checksum, no burn address. */
export function isRefundAddress(chain: DepositChain, address: string): boolean {
  switch (chain) {
    case 'eth':
    case 'base':
    case 'arb':
      return isEvm(address);
    case 'sol':
      return attempt(() => {
        const key = base58.decode(address);
        return key.length === 32 && key.some((b) => b !== 0);
      });
    case 'btc':
      return attempt(() => isBtcBase58(address)) || isBtcSegwit(address);
  }
}

/** A NEAR implicit account (64 lowercase hex): the shape of a 1Click deposit address on NEAR. */
export const isNearImplicitAccount = (address: string) => /^[0-9a-f]{64}$/.test(address);
