import { requestQuote, type DepositQuote } from './deposit';

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
