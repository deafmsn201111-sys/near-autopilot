import { describe, expect, it } from 'vitest';
import type { DepositQuote } from '../lib/deposit';
import { paymentUri } from '../lib/payment-uri';

const EVM_DEPOSIT = '0x1111111111111111111111111111111111111111';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SOL_DEPOSIT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BTC_DEPOSIT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const NATIVE = { native: true };

const quote = (
  chain: string,
  decimals: number,
  payment: unknown,
  amountIn: string,
  depositAddress: string,
) =>
  ({
    chain,
    origin: { assetId: 'x', symbol: 'X', decimals, payment },
    amountIn,
    depositAddress,
  }) as unknown as DepositQuote;

describe('paymentUri', () => {
  it('Bitcoin: BIP21 with the amount in BTC, dot decimal, no exponent', () => {
    expect(paymentUri(quote('btc', 8, NATIVE, '1', BTC_DEPOSIT))).toBe(
      `bitcoin:${BTC_DEPOSIT}?amount=0.00000001`,
    );
    expect(paymentUri(quote('btc', 8, NATIVE, '2100000000000000', BTC_DEPOSIT))).toBe(
      `bitcoin:${BTC_DEPOSIT}?amount=21000000`,
    );
  });

  it('EVM native: EIP-681 with the chain id and the value in wei as a plain integer', () => {
    const big = '5000000000000000000000';
    expect(paymentUri(quote('eth', 18, NATIVE, big, EVM_DEPOSIT))).toBe(
      `ethereum:${EVM_DEPOSIT}@1?value=${big}`,
    );
    expect(paymentUri(quote('arb', 18, NATIVE, '1', EVM_DEPOSIT))).toBe(
      `ethereum:${EVM_DEPOSIT}@42161?value=1`,
    );
  });

  it('EVM ERC-20: a transfer call on the token contract, with the chain id and base units', () => {
    expect(paymentUri(quote('base', 6, { contract: BASE_USDC }, '25000000', EVM_DEPOSIT))).toBe(
      `ethereum:${BASE_USDC}@8453/transfer?address=${EVM_DEPOSIT}&uint256=25000000`,
    );
  });

  it('Solana: Solana Pay amount in SOL, and spl-token with no more decimals than the mint', () => {
    expect(paymentUri(quote('sol', 9, NATIVE, '1', SOL_DEPOSIT))).toBe(
      `solana:${SOL_DEPOSIT}?amount=0.000000001`,
    );
    expect(paymentUri(quote('sol', 6, { contract: SOL_USDC }, '1500000', SOL_DEPOSIT))).toBe(
      `solana:${SOL_DEPOSIT}?amount=1.5&spl-token=${SOL_USDC}`,
    );
  });

  it('gives no link when the API did not name the token, or it does not fit the quote', () => {
    expect(paymentUri(quote('base', 6, null, '1', EVM_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('base', 6, undefined, '1', EVM_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('base', 6, { contract: 42 }, '1', EVM_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('eth', 6, { contract: SOL_USDC }, '1', EVM_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('sol', 6, { contract: BASE_USDC }, '1', SOL_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('btc', 8, { contract: BTC_DEPOSIT }, '1', BTC_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('eth', 18, NATIVE, '1', SOL_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('ton', 9, NATIVE, '1', 'UQabc'))).toBeNull();
    expect(paymentUri(quote('eth', 18, NATIVE, '1e21', EVM_DEPOSIT))).toBeNull();
  });
});
