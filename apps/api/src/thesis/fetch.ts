import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { z } from 'zod';
import { findBlockAt } from '../collector/backfill';
import { finalBlock } from '../yield/pinned-viewer';
import { HttpJsonClient } from '../market-data/http';
import { RAW_DIR } from './paths';

/**
 * THESIS DATA FETCH (mainnet, READ-ONLY: `block`, `gas_price` and `call_function` views through an archival RPC, plus
 * public historical price APIs). No signer, no transaction, no LLM. Writes the raw inputs of the thesis to
 * thesis/data/raw/, which is committed: `thesis:rebuild` then works offline and a clean clone gets the same numbers.
 *
 *   MAINNET_READ_RPC_API_KEY=... node --import tsx src/thesis/fetch.ts [--end 2026-11-05T00:00:00Z] [--days 90]
 *
 * What is fetched, at one block per day (the block closest to 00:00 UTC, within 10 min):
 *   - Rhea v1 registry at the END block (get_pools, paged) -> the universe: SIMPLE_POOLs with wrap.near on one side,
 *     ranked by their wrap.near reserve, top 15. The rule is applied to chain data only.
 *   - per pool and block: get_pool (amounts, total_fee, shares_total_supply) and get_pool_volumes, VERBATIM;
 *     exchange metadata (admin_fee_bps)
 *   - Burrow get_assets_paged_detailed: a projection (fields listed in PROJECTED_FIELDS) plus the sha256 of the full
 *     response, so the full answer can be re-fetched and compared
 *   - gas_price at the block
 *   - NEAR/USD: DefiLlama (coingecko:near, historical) and the Coinbase 5-minute candle at the block time, verbatim
 */
const RHEA = 'v2.ref-finance.near';
const BURROW = 'contract.main.burrow.near';
const WNEAR = 'wrap.near';
const TOP_POOLS = 15;
const PROJECTED_FIELDS = [
  'token_id',
  'supplied',
  'borrowed',
  'reserved',
  'supply_apr',
  'borrow_apr',
  'farms',
] as const;

const env = z
  .object({
    MAINNET_ARCHIVAL_RPC_URL: z.string().url().default('https://archival-rpc.mainnet.fastnear.com'),
    MAINNET_READ_RPC_API_KEY: z.string().optional(),
    DEFILLAMA_URL: z.string().url().default('https://coins.llama.fi'),
    COINBASE_URL: z.string().url().default('https://api.exchange.coinbase.com'),
  })
  .parse(process.env);

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const DAY = 86_400_000;

async function main(): Promise<void> {
  const end = new Date(arg('end') ?? '2026-11-05T00:00:00Z');
  const days = z.coerce
    .number()
    .int()
    .min(7)
    .max(180)
    .parse(arg('days') ?? 90);
  // The key goes to the archival RPC only when that is FastNEAR too (the provider that issued it). Never printed.
  const host = new URL(env.MAINNET_ARCHIVAL_RPC_URL).hostname;
  const key = host.endsWith('.fastnear.com') ? env.MAINNET_READ_RPC_API_KEY : undefined;
  const rpc = new NearRpcClient({
    url: env.MAINNET_ARCHIVAL_RPC_URL,
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
    maxConcurrent: 3,
  });
  const http = new HttpJsonClient({ maxConcurrent: 2, timeoutMs: 15_000 });
  const view = async (height: number, contract: string, method: string, args: object) => {
    const r = z.object({ result: z.array(z.number().int()) }).parse(
      await rpc.call('query', {
        request_type: 'call_function',
        block_id: height,
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      }),
    );
    return Buffer.from(r.result).toString('utf8');
  };

  // ---- blocks: one per day, oldest first
  const head = await finalBlock(rpc);
  const blocks: Array<{ height: number; hash: string; timestamp: string; target: string }> = [];
  let ref = head;
  for (let d = days; d >= 0; d -= 1) {
    const target = new Date(end.getTime() - d * DAY);
    const b = await findBlockAt(rpc, target, ref);
    const hdr = z
      .object({ header: z.object({ hash: z.string(), height: z.number() }) })
      .parse(await rpc.call('block', { block_id: b.height }));
    blocks.push({
      height: b.height,
      hash: hdr.header.hash,
      timestamp: b.timestamp.toISOString(),
      target: target.toISOString(),
    });
    ref = b;
    process.stderr.write(`block ${blocks.length}/${days + 1} ${b.height}\n`);
  }
  const last = blocks[blocks.length - 1];
  if (!last) throw new Error('no blocks');

  // ---- universe at the END block, from the chain
  const count = Number(await view(last.height, RHEA, 'get_number_of_pools', {}));
  const poolShape = z.object({
    pool_kind: z.string(),
    token_account_ids: z.array(z.string()),
    amounts: z.array(z.string()),
  });
  const candidates: Array<{ id: number; near: bigint }> = [];
  for (let from = 0; from < count; from += 200) {
    const page = z
      .array(poolShape)
      .parse(
        JSON.parse(await view(last.height, RHEA, 'get_pools', { from_index: from, limit: 200 })),
      );
    page.forEach((p, i) => {
      const at = p.token_account_ids.indexOf(WNEAR);
      if (p.pool_kind === 'SIMPLE_POOL' && p.token_account_ids.length === 2 && at >= 0)
        candidates.push({ id: from + i, near: BigInt(p.amounts[at] ?? '0') });
    });
  }
  const pools = candidates
    .sort((a, b) => (a.near === b.near ? a.id - b.id : a.near > b.near ? -1 : 1))
    .slice(0, TOP_POOLS)
    .map((c) => c.id);
  process.stderr.write(
    `universe: ${candidates.length} wNEAR SIMPLE_POOLs, top ${pools.join(',')}\n`,
  );

  mkdirSync(RAW_DIR, { recursive: true });
  const rhea: string[] = [];
  const meta: string[] = [];
  const burrow: string[] = [];
  const gas: string[] = [];
  const prices: string[] = [];
  for (const b of blocks) {
    meta.push(
      JSON.stringify({
        height: b.height,
        metadata: JSON.parse(await view(b.height, RHEA, 'metadata', {})) as unknown,
      }),
    );
    gas.push(
      JSON.stringify({ height: b.height, gas_price: await rpc.call('gas_price', [b.height]) }),
    );
    for (const id of pools) {
      let get_pool: unknown = null;
      let get_pool_volumes: unknown = null;
      let error: string | null = null;
      try {
        get_pool = JSON.parse(await view(b.height, RHEA, 'get_pool', { pool_id: id }));
        get_pool_volumes = JSON.parse(
          await view(b.height, RHEA, 'get_pool_volumes', { pool_id: id }),
        );
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 200) : 'view failed'; // e.g. the pool did not exist yet
      }
      rhea.push(JSON.stringify({ height: b.height, pool: id, get_pool, get_pool_volumes, error }));
    }
    const full = await view(b.height, BURROW, 'get_assets_paged_detailed', {
      from_index: 0,
      limit: 100,
    });
    const assets = z.array(z.record(z.unknown())).parse(JSON.parse(full));
    burrow.push(
      JSON.stringify({
        height: b.height,
        response_sha256: sha256(full),
        projected_fields: PROJECTED_FIELDS,
        assets: assets.map((a) =>
          Object.fromEntries(PROJECTED_FIELDS.map((f) => [f, a[f] ?? null])),
        ),
      }),
    );
    // NEAR/USD at the block time from two independent sources, verbatim.
    const ts = Math.floor(Date.parse(b.timestamp) / 1000);
    let defillama: unknown = null;
    let coinbase: unknown = null;
    try {
      defillama = await http.getJson(
        `${env.DEFILLAMA_URL}/prices/historical/${ts}/coingecko:near?searchWidth=2h`,
      );
    } catch (e) {
      defillama = { error: e instanceof Error ? e.message : 'failed' };
    }
    try {
      const start = new Date((ts - 600) * 1000).toISOString();
      const endT = new Date((ts + 600) * 1000).toISOString();
      coinbase = await http.getJson(
        `${env.COINBASE_URL}/products/NEAR-USD/candles?granularity=300&start=${start}&end=${endT}`,
      );
    } catch (e) {
      coinbase = { error: e instanceof Error ? e.message : 'failed' };
    }
    prices.push(JSON.stringify({ height: b.height, ts, defillama, coinbase }));
    process.stderr.write(`data ${b.height}\n`);
  }

  const w = (name: string, lines: string[]) =>
    writeFileSync(resolve(RAW_DIR, name), lines.join('\n') + '\n');
  w('rhea-pools.jsonl', rhea);
  w('rhea-metadata.jsonl', meta);
  w('burrow-assets.jsonl', burrow);
  w('gas-price.jsonl', gas);
  w('near-usd.jsonl', prices);
  writeFileSync(
    resolve(RAW_DIR, 'manifest.json'),
    JSON.stringify(
      {
        description:
          'Raw inputs of THESIS.md: mainnet view calls at one block per day through an archival RPC, and public NEAR/USD history. Read-only.',
        network: 'mainnet',
        archivalRpcHost: host,
        rhea: RHEA,
        burrow: BURROW,
        end: end.toISOString(),
        days,
        blocks,
        universe: {
          rule: `v1 SIMPLE_POOLs with ${WNEAR} on one side, ranked by ${WNEAR} reserve at block ${last.height}, top ${TOP_POOLS}`,
          candidates: candidates.length,
          pools,
        },
        priceSources: [
          'DefiLlama coingecko:near (historical, searchWidth 2h)',
          'Coinbase NEAR-USD 5-minute candles',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  process.stderr.write(`done: ${blocks.length} blocks, ${pools.length} pools -> ${RAW_DIR}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`thesis fetch failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
