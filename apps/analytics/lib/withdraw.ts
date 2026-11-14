import {
  DEPOSIT_CHAINS,
  requestQuote,
  type DepositAsset,
  type DepositQuote,
  type DepositStatus,
} from './deposit';

/** Chains a withdrawal may go to (the API's list; no Bitcoin). */
export const WITHDRAW_CHAINS = ['eth', 'base', 'arb', 'sol'] as const;

export interface WithdrawForm {
  readonly account: string;
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amount: string;
  readonly recipient: string;
}

export const requestWithdrawQuote = (form: WithdrawForm) =>
  requestQuote<DepositQuote>('/api/withdraw/quote', form);

/**
 * `percent` of a wallet balance as a decimal string, rounded down so it never asks for more than is held. The
 * portfolio reports balances floored to at most 6 decimals, so the amount is cut to those places.
 */
export function shareOf(balance: number, percent: number, decimals: number): string {
  const places = Math.min(6, decimals);
  const units = BigInt(Math.round(balance * 10 ** places));
  const share = (units * BigInt(percent)) / 100n;
  const digits = share.toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** A token the connected NEAR wallet holds, as the portfolio reports it (floored to at most 6 decimals). */
export interface WalletBalance {
  readonly token: string;
  readonly amount: number;
}

export interface WithdrawSource extends DepositAsset {
  readonly balance: number;
}

const WNEAR = 'wrap.near';
// ponytail: copy of the API's NEAR_RESERVE; serve it from the API if it ever changes.
/** Native NEAR left in the wallet for fees, as the API keeps when it wraps NEAR for a withdrawal. */
const NEAR_FEE_RESERVE = 1;

/**
 * The listed NEAR tokens the wallet can withdraw, with their balance. Native NEAR joins wNEAR as one "NEAR" (the API
 * wraps what the quote lacks, #237), less the fee reserve.
 */
export function withdrawSources(
  assets: readonly DepositAsset[],
  balances: readonly WalletBalance[],
): WithdrawSource[] {
  const of = (token: string) => balances.find((b) => b.token === token)?.amount ?? 0;
  return assets.flatMap((a) => {
    if (!a.assetId.startsWith('nep141:')) return [];
    const token = a.assetId.slice('nep141:'.length);
    if (token !== WNEAR) return of(token) > 0 ? [{ ...a, balance: of(token) }] : [];
    // In millionths: balances come floored to 6 decimals, so the sum stays exact.
    const micro = (n: number) => Math.round(n * 1e6);
    const spare = Math.max(0, micro(of('near')) - micro(NEAR_FEE_RESERVE));
    const balance = (micro(of(WNEAR)) + spare) / 1e6;
    return balance > 0 ? [{ ...a, symbol: 'NEAR', balance }] : [];
  });
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * The typed amount as integer base units, or why it cannot be quoted; null while empty. A comma counts as the decimal
 * point. The balance is compared in base units, floored like `shareOf`, so Max always passes.
 */
export function parseAmount(
  text: string,
  decimals: number,
  balance: number,
): { amount: string; units: bigint } | { error: string } | null {
  const amount = text.trim().replace(',', '.');
  if (!amount) return null;
  const m = DECIMAL.exec(amount);
  if (!m) return { error: 'Type a number, like 12.5.' };
  const frac = m[2] ?? '';
  if (frac.length > decimals) return { error: `This token has at most ${decimals} decimals.` };
  const units = BigInt(m[1] + frac.padEnd(decimals, '0'));
  if (units === 0n) return { error: 'Type an amount above 0.' };
  const held = shareOf(balance, 100, decimals);
  const [whole, part = ''] = held.split('.');
  if (units > BigInt(whole + part.padEnd(decimals, '0')))
    return { error: `More than your balance of ${held}.` };
  return { amount, units };
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Why the address cannot be on this chain, by its shape; the API checks it fully (checksum). Null when it may be. */
export function addressError(chain: string, address: string): string | null {
  const a = address.trim();
  if (!a) return null;
  if (chain === 'sol')
    return SOLANA.test(a)
      ? null
      : 'A Solana address is 32 to 44 letters and digits, without 0, O, I or l.';
  const name = DEPOSIT_CHAINS.find((c) => c.id === chain)?.name ?? chain;
  return EVM.test(a) ? null : `An ${name} address is 0x and 40 hex characters.`;
}

/** The withdraw timeline's 4 steps: signed, seen by 1Click, swapping, arrived. */
export interface Timeline {
  /** How many steps are done; the next one is in progress unless it ended. */
  readonly done: number;
  readonly end?: 'ok' | 'watch' | 'liq';
}

export function timelineOf(s: DepositStatus | null): Timeline {
  switch (s?.status) {
    case 'PENDING_DEPOSIT':
      return s.deadlinePassed ? { done: 1, end: 'watch' } : { done: 1 };
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return { done: 2 };
    case 'SUCCESS':
      return { done: 4, end: 'ok' };
    case 'REFUNDED':
    case 'INCOMPLETE_DEPOSIT':
      return { done: 2, end: 'watch' };
    case 'FAILED':
      return { done: 2, end: 'liq' };
    default:
      return { done: 1 };
  }
}
