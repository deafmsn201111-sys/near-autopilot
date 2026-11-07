import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { z } from 'zod';
import { RAW_DIR } from './paths';

/**
 * SURVIVORSHIP-BIAS FIX for the thesis data (mainnet, READ-ONLY view calls through an archival RPC).
 *
 * The original universe was the top 15 wNEAR SIMPLE_POOLs by wNEAR reserve at the LAST block: only pools that were
 * still big at the end, i.e. the survivors. This adds the top 15 at the FIRST block, so pools that shrank or were
 * drained during the window are analysed too. For every added pool it fetches the same two views (get_pool,
 * get_pool_volumes) at the same daily blocks already in the raw data, and appends them to rhea-pools.jsonl. Nothing
 * already fetched is changed; the manifest records both rankings.
 *
 *   MAINNET_READ_RPC_API_KEY=... node --import tsx src/thesis/extend.ts
 */
const RHEA = 'v2.ref-finance.near';
const WNEAR = 'wrap.near';
const TOP = 15;

const env = z
  .object({
    MAINNET_ARCHIVAL_RPC_URL: z.string().url().default('https://archival-rpc.mainnet.fastnear.com'),
    MAINNET_READ_RPC_API_KEY: z.string().optional(),
  })
  .parse(process.env);

interface Manifest {
  blocks: { height: number }[];
  universe: Record<string, unknown> & { pools: number[]; rule: string };
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const host = new URL(env.MAINNET_ARCHIVAL_RPC_URL).hostname;
  const key = host.endsWith('.fastnear.com') ? env.MAINNET_READ_RPC_API_KEY : undefined;
  const rpc = new NearRpcClient({
    url: env.MAINNET_ARCHIVAL_RPC_URL,
    headers: key ? { authorization: `Bearer ${key}` } : undefined,
    maxConcurrent: 3,
  });
  const view = async (height: number, method: string, args: object) => {
    const r = z.object({ result: z.array(z.number().int()) }).parse(
      await rpc.call('query', {
        request_type: 'call_function',
        block_id: height,
        account_id: RHEA,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      }),
    );
    return Buffer.from(r.result).toString('utf8');
  };

  const manifestPath = resolve(RAW_DIR, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  if (manifest.universe['startPools']) {
    process.stderr.write(
      'the universe already includes the start-of-window ranking: nothing to do\n',
    );
    return;
  }
  const first = manifest.blocks[0];
  if (!first) throw new Error('no blocks in the manifest');

  // ---- the same ranking rule, at the FIRST block
  const count = Number(await view(first.height, 'get_number_of_pools', {}));
  const shape = z.object({
    pool_kind: z.string(),
    token_account_ids: z.array(z.string()),
    amounts: z.array(z.string()),
  });
  const candidates: { id: number; near: bigint }[] = [];
  for (let from = 0; from < count; from += 200) {
    const page = z
      .array(shape)
      .parse(JSON.parse(await view(first.height, 'get_pools', { from_index: from, limit: 200 })));
    page.forEach((p, i) => {
      const at = p.token_account_ids.indexOf(WNEAR);
      if (p.pool_kind === 'SIMPLE_POOL' && p.token_account_ids.length === 2 && at >= 0)
        candidates.push({ id: from + i, near: BigInt(p.amounts[at] ?? '0') });
    });
  }
  const startPools = candidates
    .sort((a, b) => (a.near === b.near ? a.id - b.id : a.near > b.near ? -1 : 1))
    .slice(0, TOP)
    .map((c) => c.id);
  const endPools = manifest.universe.pools;
  const added = startPools.filter((id) => !endPools.includes(id));
  process.stderr.write(
    `start-of-window top ${TOP}: ${startPools.join(',')}; new: ${added.join(',') || 'none'}\n`,
  );

  // ---- the same daily views for the added pools
  const lines: string[] = [];
  for (const b of manifest.blocks) {
    for (const id of added) {
      let get_pool: unknown = null;
      let get_pool_volumes: unknown = null;
      let error: string | null = null;
      try {
        get_pool = JSON.parse(await view(b.height, 'get_pool', { pool_id: id }));
        get_pool_volumes = JSON.parse(await view(b.height, 'get_pool_volumes', { pool_id: id }));
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 200) : 'view failed';
      }
      lines.push(JSON.stringify({ height: b.height, pool: id, get_pool, get_pool_volumes, error }));
    }
    process.stderr.write(`block ${b.height}\n`);
  }
  const rheaPath = resolve(RAW_DIR, 'rhea-pools.jsonl');
  const before = readFileSync(rheaPath, 'utf8');
  writeFileSync(
    rheaPath,
    before.endsWith('\n') ? before + lines.join('\n') + '\n' : `${before}\n${lines.join('\n')}\n`,
  );
  manifest.universe = {
    ...manifest.universe,
    rule: `v1 SIMPLE_POOLs with ${WNEAR} on one side: the union of the top ${TOP} by ${WNEAR} reserve at the FIRST block (${first.height}) and at the LAST block, so pools that shrank during the window are included (survivorship bias)`,
    endPools,
    startPools,
    pools: [...endPools, ...added],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`done: ${added.length} pools added, ${lines.length} raw lines\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
