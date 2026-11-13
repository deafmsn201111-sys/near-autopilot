import { describe, expect, it } from 'vitest';
import { isRefundAddress } from '../src/gateway/refund-address';

describe('isRefundAddress', () => {
  it.each(['eth', 'base', 'arb'] as const)('%s takes 0x + 40 hex only', (chain) => {
    expect(isRefundAddress(chain, '0x2527d02599ba641c19fea793cd0f167589a0f10d')).toBe(true);
    expect(isRefundAddress(chain, '0x2527D02599Ba641c19FEa793cD0F167589a0f10D')).toBe(true);
    expect(isRefundAddress(chain, '2527d02599ba641c19fea793cd0f167589a0f10d')).toBe(false);
    expect(isRefundAddress(chain, '0x2527d02599ba641c19fea793cd0f167589a0f10')).toBe(false);
    expect(isRefundAddress(chain, '0x2527d02599ba641c19fea793cd0f167589a0f10g')).toBe(false);
    expect(isRefundAddress(chain, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(false);
  });

  it('sol takes base58 that decodes to a 32-byte key', () => {
    expect(isRefundAddress('sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isRefundAddress('sol', '11111111111111111111111111111111')).toBe(true);
    expect(isRefundAddress('sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4w')).toBe(false);
    expect(isRefundAddress('sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v1')).toBe(false);
    expect(isRefundAddress('sol', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt10')).toBe(false);
    expect(isRefundAddress('sol', '0x2527d02599ba641c19fea793cd0f167589a0f10d')).toBe(false);
  });

  it('btc takes mainnet P2PKH and P2SH with a valid checksum', () => {
    expect(isRefundAddress('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    expect(isRefundAddress('btc', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    expect(isRefundAddress('btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb')).toBe(false);
    expect(isRefundAddress('btc', 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false);
  });

  it('btc takes mainnet bech32 v0 and bech32m v1+, checksum checked', () => {
    expect(isRefundAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(true);
    expect(
      isRefundAddress('btc', 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3'),
    ).toBe(true);
    expect(
      isRefundAddress('btc', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'),
    ).toBe(true);
    expect(isRefundAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')).toBe(false);
    expect(isRefundAddress('btc', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toBe(false);
    // v1 encoded with the bech32 (v0) checksum: BIP-350 says invalid
    expect(
      isRefundAddress('btc', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd'),
    ).toBe(false);
    expect(isRefundAddress('btc', '0x2527d02599ba641c19fea793cd0f167589a0f10d')).toBe(false);
  });

  it('refuses surrounding whitespace and an empty string', () => {
    expect(isRefundAddress('eth', ' 0x2527d02599ba641c19fea793cd0f167589a0f10d')).toBe(false);
    expect(isRefundAddress('btc', '')).toBe(false);
  });
});
