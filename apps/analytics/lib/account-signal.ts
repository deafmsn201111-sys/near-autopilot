const RPC = 'https://rpc.mainnet.fastnear.com';
export const COOLDOWN_MS = 30_000;

export interface Reading {
  height: number;
  amount: string;
}

export interface WatchState {
  last: Reading | null;
  firedAt: number;
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

/**
 * Decides whether a reading means something landed. Readings from an older block than the last one (a lagging node,
 * a slow answer) are dropped. After a refresh starts, further changes only move the baseline for `COOLDOWN_MS`, so
 * the gas refund that follows an own transaction, dust, or a busy contract do not start refresh after refresh.
 */
export function watchStep(
  state: WatchState,
  reading: Reading | null,
  now: number,
): { state: WatchState; fire: boolean } {
  if (!reading || (state.last && reading.height <= state.last.height))
    return { state, fire: false };
  const changed = state.last !== null && reading.amount !== state.last.amount;
  const fire = changed && now - state.firedAt >= COOLDOWN_MS;
  return { state: { last: reading, firedAt: fire ? now : state.firedAt }, fire };
}
