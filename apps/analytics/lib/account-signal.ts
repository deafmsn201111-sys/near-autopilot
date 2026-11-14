import { z } from 'zod';

const RPC = 'https://rpc.mainnet.fastnear.com';
const FT_INDEX = 'https://api.fastnear.com/v1/account';

export interface Reading {
  height: number;
  amount: string;
  /** Fingerprint of every token balance (readTokens); null or absent when that read failed. */
  tokens?: string | null;
}

/**
 * The account's native balance at `optimistic` finality. It moves on an incoming NEAR transfer and on every own
 * transaction (gas), so one call per tick sees both. Null on any network or RPC error: the tick is skipped.
 */
export async function readAccount(account: string): Promise<Reading | null> {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'w',
        method: 'query',
        params: { request_type: 'view_account', finality: 'optimistic', account_id: account },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { amount?: unknown; block_height?: unknown } };
    const { amount, block_height: height } = json.result ?? {};
    return typeof amount === 'string' && typeof height === 'number' ? { height, amount } : null;
  } catch {
    return null;
  }
}

const ftAnswer = z.object({ tokens: z.array(z.unknown()) });
const ftToken = z.object({ contract_id: z.string(), balance: z.string() });

/**
 * Every fungible-token balance of the account, from FastNEAR's indexer (the source the API discovers tokens from, D18),
 * as one comparable string. An incoming token transfer does not move the native balance, so readAccount misses it.
 * Null on any network, HTTP or shape error: the tick keeps its token baseline. A malformed entry is dropped, not the read.
 */
export async function readTokens(account: string): Promise<string | null> {
  try {
    const res = await fetch(`${FT_INDEX}/${encodeURIComponent(account)}/ft`);
    if (!res.ok) return null;
    const parsed = ftAnswer.safeParse(await res.json());
    if (!parsed.success) return null;
    return parsed.data.tokens
      .flatMap((entry) => {
        const t = ftToken.safeParse(entry);
        return t.success ? [`${t.data.contract_id}:${t.data.balance}`] : [];
      })
      .sort()
      .join('|');
  } catch {
    return null;
  }
}

// ponytail: 4 significant digits, as the portfolio's own change check; a smaller move (gas refund, dust) would not show
const visible = (amount: string) => Number(amount).toPrecision(4);

/**
 * Decides whether a reading means something landed. Readings from an older or the same block as the last one (a
 * lagging node, a slow answer) are dropped. It fires when the balance moves at 4 significant digits or any token balance changes, unless a portfolio
 * refresh is running or just ended (`quiet`): that refresh already shows the new state.
 */
export function watchStep(
  last: Reading | null,
  reading: Reading | null,
  quiet: boolean,
): { last: Reading | null; fire: boolean } {
  if (!reading || (last && reading.height <= last.height)) return { last, fire: false };
  const tokens = reading.tokens ?? last?.tokens ?? null;
  const moved =
    last !== null &&
    (visible(reading.amount) !== visible(last.amount) ||
      (typeof reading.tokens === 'string' &&
        typeof last.tokens === 'string' &&
        reading.tokens !== last.tokens));
  return { last: { ...reading, tokens }, fire: moved && !quiet };
}
