import { z } from 'zod';
import { formatUnits, type DepositQuote } from './deposit';

const EVM_CHAIN_IDS: Record<string, number> = { eth: 1, base: 8453, arb: 42161 };
const UNITS = /^\d{1,40}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BTC_ADDRESS = /^[a-zA-Z0-9]{25,90}$/;
const payment = z
  .union([z.object({ native: z.literal(true) }), z.object({ contract: z.string() })])
  .nullable()
  .catch(null);

/**
 * A payment link that fills in the address, exact amount, token and network: BIP21, EIP-681 (always with the chain
 * id) or Solana Pay. Null when the chain has no standard or the API did not name the token: the QR then holds the
 * address only. Amounts come from base-unit strings, so there is never an exponent.
 */
export function paymentUri(q: DepositQuote): string | null {
  const { chain, depositAddress: to, amountIn: units } = q;
  const pay = payment.parse(q.origin.payment);
  if (!pay || !UNITS.test(units)) return null;
  const contract = 'contract' in pay ? pay.contract : null;
  const chainId = EVM_CHAIN_IDS[chain];
  if (chainId) {
    if (!EVM_ADDRESS.test(to)) return null;
    if (!contract) return `ethereum:${to}@${chainId}?value=${units}`;
    return EVM_ADDRESS.test(contract)
      ? `ethereum:${contract}@${chainId}/transfer?address=${to}&uint256=${units}`
      : null;
  }
  if (chain === 'sol') {
    if (!BASE58.test(to)) return null;
    const link = `solana:${to}?amount=${formatUnits(units, q.origin.decimals)}`;
    if (!contract) return link;
    return BASE58.test(contract) ? `${link}&spl-token=${contract}` : null;
  }
  if (chain === 'btc' && !contract && BTC_ADDRESS.test(to))
    return `bitcoin:${to}?amount=${formatUnits(units, q.origin.decimals)}`;
  return null;
}
