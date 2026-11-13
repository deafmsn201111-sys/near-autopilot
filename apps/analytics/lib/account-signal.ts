const RPC = 'https://rpc.mainnet.fastnear.com';

async function query<T>(params: Record<string, string>): Promise<T | undefined> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'w',
      method: 'query',
      params: { ...params, finality: 'optimistic' },
    }),
  });
  return ((await res.json()) as { result?: T }).result;
}

/**
 * A snapshot of what moves when anything lands on the account: the highest access-key nonce (its own transactions,
 * including relayed ones that leave the balance alone) and the native balance (incoming transfers). Any difference
 * between two snapshots means the portfolio changed. Null on a network hiccup.
 */
export async function readAccountSignal(account: string): Promise<string | null> {
  try {
    const [keys, view] = await Promise.all([
      query<{ keys?: { access_key?: { nonce?: number | string } }[] }>({
        request_type: 'view_access_key_list',
        account_id: account,
      }),
      query<{ amount?: string }>({ request_type: 'view_account', account_id: account }),
    ]);
    if (view?.amount === undefined) return null;
    let max = 0n;
    for (const k of keys?.keys ?? []) {
      const n = k.access_key?.nonce;
      if (n !== undefined && BigInt(n) > max) max = BigInt(n);
    }
    return `${max}:${view.amount}`;
  } catch {
    return null;
  }
}
