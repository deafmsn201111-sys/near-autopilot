import { accountIdSchema } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * What an account holds beyond the allowlists, from public indexers: FastNEAR for its fungible tokens and staking pools,
 * Rhea's API for the v1 pools it has liquidity in, Rhea's indexer for estimated token prices. Every answer is untrusted:
 * zod-validated, size and count capped, and null when the indexer is down (the caller falls back to the allowlists).
 * Pool shares and staked balances are then read on-chain; an indexer is only a hint of where to look.
 */
export interface AccountDiscovery {
  account(id: string): Promise<{
    tokens: { token: string; raw: bigint }[];
    stakingPools: string[];
  } | null>;
  v1PoolIds(id: string): Promise<number[] | null>;
  /** USD per whole token, an estimate from Rhea's pools; never used to size or allow an action. */
  prices(): Promise<ReadonlyMap<string, number> | null>;
  /** USD traded in the last 24 h per DCL pool id, Rhea's indexer; an estimate the LP Optimizer may size advice with. */
  dclVolumes24hUsd(): Promise<ReadonlyMap<string, number> | null>;
}

export const MAX_DISCOVERED = { tokens: 200, stakingPools: 5, v1Pools: 20 } as const;
const MAX_BODY_BYTES = 4_000_000;
const TIMEOUT_MS = 5_000;
const PRICES_TTL_MS = 5 * 60_000;

const u128 = z.string().regex(/^\d{1,39}$/);
const fullSchema = z.object({
  tokens: z.array(z.unknown()).default([]),
  pools: z.array(z.unknown()).default([]),
});
const tokenSchema = z.object({ contract_id: accountIdSchema, balance: u128 });
const stakingSchema = z.object({ pool_id: accountIdSchema });
const v1PoolSchema = z.object({ id: z.string().regex(/^\d{1,9}$/) });
const priceSchema = z.object({ price: z.string().regex(/^\d{1,20}(\.\d+)?$/) });
const dclListSchema = z.object({
  code: z.literal(0),
  data: z.object({ list: z.array(z.unknown()) }),
});
const dclVolumeSchema = z.object({
  id: z.string().min(1).max(200),
  volume_24h: z.string().regex(/^\d{1,15}(\.\d+)?$/),
});
/** The busiest DCL pools by TVL; an allowlisted pool outside them reads as "no volume data". */
const DCL_LIST_URL = 'https://indexer.ref.finance/list-pools?type=dcl&sort=tvl&limit=100&offset=0';

const valid = <T>(schema: z.ZodType<T>, items: readonly unknown[]) =>
  items.flatMap((x) => {
    const r = schema.safeParse(x);
    return r.success ? [r.data] : [];
  });

export function httpDiscovery(fetchImpl: typeof fetch = fetch, now = Date.now): AccountDiscovery {
  const get = async (url: string): Promise<unknown> => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) return null;
      const text = await res.text();
      return text.length > MAX_BODY_BYTES ? null : (JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  };
  type Cache = { at: number; value: Promise<ReadonlyMap<string, number> | null> } | null;
  const cached = (slot: { c: Cache }, load: () => Promise<ReadonlyMap<string, number> | null>) => {
    if (slot.c && now() - slot.c.at < PRICES_TTL_MS) return slot.c.value;
    const value = load();
    slot.c = { at: now(), value };
    void value.then((v) => {
      if (v === null && slot.c?.value === value) slot.c = null;
    });
    return value;
  };
  const priceSlot = { c: null as Cache };
  const volumeSlot = { c: null as Cache };

  return {
    async account(id) {
      const body = fullSchema.safeParse(
        await get(`https://api.fastnear.com/v1/account/${encodeURIComponent(id)}/full`),
      );
      if (!body.success) return null;
      return {
        tokens: valid(tokenSchema, body.data.tokens)
          .map((t) => ({ token: t.contract_id, raw: BigInt(t.balance) }))
          .filter((t) => t.raw > 0n)
          .slice(0, MAX_DISCOVERED.tokens),
        stakingPools: [
          ...new Set(valid(stakingSchema, body.data.pools).map((p) => p.pool_id)),
        ].slice(0, MAX_DISCOVERED.stakingPools),
      };
    },
    async v1PoolIds(id) {
      const body = z
        .array(z.unknown())
        .safeParse(await get(`https://api.ref.finance/liquidity-pools/${encodeURIComponent(id)}`));
      if (!body.success) return null;
      return valid(v1PoolSchema, body.data)
        .map((p) => Number(p.id))
        .slice(0, MAX_DISCOVERED.v1Pools);
    },
    prices() {
      return cached(priceSlot, () =>
        get('https://indexer.ref.finance/list-token-price').then((raw) => {
          const body = z.record(z.unknown()).safeParse(raw);
          if (!body.success) return null;
          const out = new Map<string, number>();
          for (const [token, entry] of Object.entries(body.data)) {
            const p = priceSchema.safeParse(entry);
            const usd = p.success ? Number(p.data.price) : 0;
            if (accountIdSchema.safeParse(token).success && Number.isFinite(usd) && usd > 0)
              out.set(token, usd);
          }
          return out;
        }),
      );
    },
    dclVolumes24hUsd() {
      return cached(volumeSlot, () =>
        get(DCL_LIST_URL).then((raw) => {
          const body = dclListSchema.safeParse(raw);
          if (!body.success) return null;
          return new Map(
            valid(dclVolumeSchema, body.data.data.list).map((p) => [p.id, Number(p.volume_24h)]),
          );
        }),
      );
    },
  };
}

/** A token symbol from ft_metadata is attacker-chosen text: letters, digits and . - _ only, at most 12 characters. */
export function displaySymbol(symbol: string, token: string): string {
  const clean = symbol.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12);
  return clean || (token.split('.')[0] ?? token).slice(0, 12);
}
