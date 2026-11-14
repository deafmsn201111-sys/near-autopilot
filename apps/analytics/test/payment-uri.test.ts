import { describe, expect, it } from 'vitest';
import type { DepositQuote } from '../lib/deposit';
import { paymentUri } from '../lib/payment-uri';

const EVM_DEPOSIT = '0x1111111111111111111111111111111111111111';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SOL_DEPOSIT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BTC_DEPOSIT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

const quote = (
  chain: string,
  origin: { symbol: string; decimals: number; contract?: string | null },
  amountIn: string,
  depositAddress: string,
) =>
  ({
    chain,
    origin: { assetId: 'x', contract: null, ...origin },
    amountIn,
    depositAddress,
  }) as unknown as DepositQuote;

describe('paymentUri', () => {
  it('Bitcoin: BIP21 with the amount in BTC, dot decimal, no exponent', () => {
    expect(paymentUri(quote('btc', { symbol: 'BTC', decimals: 8 }, '1', BTC_DEPOSIT))).toBe(
      `bitcoin:${BTC_DEPOSIT}?amount=0.00000001`,
    );
    expect(
      paymentUri(quote('btc', { symbol: 'BTC', decimals: 8 }, '2100000000000000', BTC_DEPOSIT)),
    ).toBe(`bitcoin:${BTC_DEPOSIT}?amount=21000000`);
  });

  it('EVM native: EIP-681 with the chain id and the value in wei as a plain integer', () => {
    const big = '5000000000000000000000';
    expect(paymentUri(quote('eth', { symbol: 'ETH', decimals: 18 }, big, EVM_DEPOSIT))).toBe(
      `ethereum:${EVM_DEPOSIT}@1?value=${big}`,
    );
    expect(paymentUri(quote('arb', { symbol: 'ETH', decimals: 18 }, '1', EVM_DEPOSIT))).toBe(
      `ethereum:${EVM_DEPOSIT}@42161?value=1`,
    );
  });

  it('EVM ERC-20: a transfer call on the token contract, with the chain id and base units', () => {
    expect(
      paymentUri(
        quote(
          'base',
          { symbol: 'USDC', decimals: 6, contract: BASE_USDC },
          '25000000',
          EVM_DEPOSIT,
        ),
      ),
    ).toBe(`ethereum:${BASE_USDC}@8453/transfer?address=${EVM_DEPOSIT}&uint256=25000000`);
  });

  it('Solana: Solana Pay amount in SOL, and spl-token with no more decimals than the mint', () => {
    expect(paymentUri(quote('sol', { symbol: 'SOL', decimals: 9 }, '1', SOL_DEPOSIT))).toBe(
      `solana:${SOL_DEPOSIT}?amount=0.000000001`,
    );
    expect(
      paymentUri(
        quote('sol', { symbol: 'USDC', decimals: 6, contract: SOL_USDC }, '1500000', SOL_DEPOSIT),
      ),
    ).toBe(`solana:${SOL_DEPOSIT}?amount=1.5&spl-token=${SOL_USDC}`);
  });

  it('gives no link when the quote does not say exactly which token to pay', () => {
    // A token without a contract is not the chain's native coin.
    expect(paymentUri(quote('base', { symbol: 'USDC', decimals: 6 }, '1', EVM_DEPOSIT))).toBeNull();
    expect(
      paymentUri(quote('btc', { symbol: 'BTC(OMNI)', decimals: 8 }, '1', BTC_DEPOSIT)),
    ).toBeNull();
    // A contract that is not an address of the quote's chain is refused, not encoded.
    expect(
      paymentUri(
        quote('eth', { symbol: 'USDC', decimals: 6, contract: SOL_USDC }, '1', EVM_DEPOSIT),
      ),
    ).toBeNull();
    expect(
      paymentUri(
        quote('sol', { symbol: 'USDC', decimals: 6, contract: BASE_USDC }, '1', SOL_DEPOSIT),
      ),
    ).toBeNull();
    // A deposit address of another chain, or a chain with no standard.
    expect(paymentUri(quote('eth', { symbol: 'ETH', decimals: 18 }, '1', SOL_DEPOSIT))).toBeNull();
    expect(paymentUri(quote('ton', { symbol: 'TON', decimals: 9 }, '1', 'UQabc'))).toBeNull();
    expect(
      paymentUri(quote('eth', { symbol: 'ETH', decimals: 18 }, '1e21', EVM_DEPOSIT)),
    ).toBeNull();
  });
});
