import { formatUnits, type DepositQuote } from './deposit';

const EVM_CHAIN_IDS: Record<string, number> = { eth: 1, base: 8453, arb: 42161 };
const NATIVE: Record<string, { symbol: string; decimals: number }> = {
  eth: { symbol: 'ETH', decimals: 18 },
  base: { symbol: 'ETH', decimals: 18 },
  arb: { symbol: 'ETH', decimals: 18 },
  sol: { symbol: 'SOL', decimals: 9 },
  btc: { symbol: 'BTC', decimals: 8 },
};
const UNITS = /^\d{1,40}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BTC_ADDRESS = /^[a-zA-Z0-9]{25,90}$/;

/**
 * A payment link that fills in the address, exact amount, token and network: BIP21, EIP-681 (always with the chain
 * id) or Solana Pay. Null when the chain has no standard or the quote does not name the token exactly: the QR then
 * holds the address only. Amounts come from base-unit strings, so there is never an exponent.
 */
export function paymentUri(q: DepositQuote): string | null {
  const { chain, depositAddress: to, amountIn: units } = q;
  const { symbol, decimals, contract } = q.origin;
  if (!UNITS.test(units)) return null;
  const n = NATIVE[chain];
  const native = !contract && n?.symbol === symbol && n.decimals === decimals;
  const chainId = EVM_CHAIN_IDS[chain];
  if (chainId) {
    if (!EVM_ADDRESS.test(to)) return null;
    if (native) return `ethereum:${to}@${chainId}?value=${units}`;
    return contract && EVM_ADDRESS.test(contract)
      ? `ethereum:${contract}@${chainId}/transfer?address=${to}&uint256=${units}`
      : null;
  }
  if (chain === 'sol') {
    if (!BASE58.test(to)) return null;
    const pay = `solana:${to}?amount=${formatUnits(units, decimals)}`;
    if (native) return pay;
    return contract && BASE58.test(contract) ? `${pay}&spl-token=${contract}` : null;
  }
  if (chain === 'btc' && native && BTC_ADDRESS.test(to))
    return `bitcoin:${to}?amount=${formatUnits(units, decimals)}`;
  return null;
}
