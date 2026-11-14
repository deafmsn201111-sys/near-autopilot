import { requestQuote, type DepositAsset, type DepositQuote } from './deposit';

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
