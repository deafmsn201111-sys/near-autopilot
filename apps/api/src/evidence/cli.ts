import { readFileSync } from 'node:fs';
import { createDatabase } from '@near-autopilot/db';
import { policyConfigSchema, type PolicyConfig } from '@near-autopilot/policy-engine';
import { z } from 'zod';
import { checkpointAll, generateCheckpointKey, verifyCheckpoints } from './checkpoint';
import { replayVerdict } from './replay';
import { EvidenceStore } from './store';

/**
 * EVIDENCE CLI, read-only (SELECTs only; nothing is written, fetched or executed):
 *
 *   audit:verify [--chain simulation:mainnet]
 *       Recomputes every audit hash chain from the database, seq 1 to head. Exit 1 if any chain is broken.
 *   audit:replay [--id <verdict id>] [--limit 200] [--config config/market.json ...]
 *       Re-evaluates stored policy verdicts on their stored inputs and compares. --config supplies the policy for rows
 *       stored before configs were recorded with verdicts (used only when its version matches). Exit 1 on a mismatch.
 *
 *   audit:verify also checks the signed checkpoints when AUDIT_CHECKPOINT_PUBLIC_KEY is set (file: AUDIT_CHECKPOINT_FILE).
 *   checkpoint            signs the current head of every chain (needs AUDIT_CHECKPOINT_KEY; writes the table and file)
 *   checkpoint-keygen     prints a NEW key pair as two .env lines (the quickstart appends them to .env, unprinted)
 *
 * Output: one JSON object per line, then a summary line. DATABASE_URL is read from the environment and never printed.
 */
const args = process.argv.slice(2);
const command = args[0];
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const opts = (name: string): string[] =>
  args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1] as string] : []));
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

function loadPolicy(path: string): PolicyConfig {
  const json = JSON.parse(readFileSync(path, 'utf8')) as { policy?: unknown };
  return policyConfigSchema.parse(json.policy);
}

async function main(): Promise<number> {
  if (command === 'checkpoint-keygen') {
    const k = generateCheckpointKey();
    process.stdout.write(
      `AUDIT_CHECKPOINT_KEY=${k.privateHex}\nAUDIT_CHECKPOINT_PUBLIC_KEY=${k.publicHex}\n`,
    );
    return 0;
  }
  const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
  const database = createDatabase(DATABASE_URL, { max: 2 });
  const store = new EvidenceStore(database.db);
  try {
    if (command === 'checkpoint') {
      const key = process.env['AUDIT_CHECKPOINT_KEY'];
      if (!key) {
        out({ error: 'AUDIT_CHECKPOINT_KEY is not set' });
        return 1;
      }
      const file = process.env['AUDIT_CHECKPOINT_FILE'];
      for (const c of await checkpointAll(database.db, key, file ? { file } : {}))
        out({ signed: c.chain, seq: c.seq });
      return 0;
    }
    if (command === 'verify') {
      const { chains, unchained } = await store.chains();
      const only = opt('chain');
      const selected = only ? chains.filter((c) => c.chain === only) : chains;
      if (only && selected.length === 0) {
        out({ chain: only, ok: false, error: 'no such chain' });
        return 1;
      }
      let broken = 0;
      for (const c of selected) {
        const r = await store.verify(c.chain);
        if (!r.ok) broken += 1;
        out({ ...r, firstAt: c.firstAt.toISOString(), lastAt: c.lastAt.toISOString() });
      }
      const pub = process.env['AUDIT_CHECKPOINT_PUBLIC_KEY'];
      const file = process.env['AUDIT_CHECKPOINT_FILE'];
      const checks = pub ? await verifyCheckpoints(database.db, pub, file ? { file } : {}) : [];
      for (const ch of checks) out({ checkpoints: ch });
      const badCheckpoints = checks.filter((x) => !x.ok).length;
      broken += badCheckpoints;
      out({
        summary: 'audit:verify',
        chains: selected.length,
        checkpoints: pub
          ? badCheckpoints === 0
            ? 'ok'
            : 'FAILED'
          : 'not configured (AUDIT_CHECKPOINT_PUBLIC_KEY)',
        broken,
        unchainedRowsBeforeMigration0011: unchained,
      });
      return broken === 0 ? 0 : 1;
    }
    if (command === 'replay') {
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(10_000)
        .parse(opt('limit') ?? 200);
      const id = opt('id');
      const configs = opts('config').map(loadPolicy);
      const rows = await store.verdicts(id === undefined ? { limit } : { id, limit: 1 });
      const tally = { match: 0, mismatch: 0, not_replayable: 0 };
      for (const r of rows) {
        const result = replayVerdict({ ...r }, configs);
        tally[result.status] += 1;
        out({
          ...result,
          evaluatedAt: r.evaluatedAt.toISOString(),
          dataSource: r.dataSource,
          network: r.network,
        });
      }
      out({ summary: 'audit:replay', verdicts: rows.length, ...tally });
      if (id !== undefined && rows.length === 0) return 1;
      return tally.mismatch === 0 ? 0 : 1;
    }
    process.stderr.write(
      'usage: cli.ts verify [--chain <chain>] | replay [--id <id>] [--limit N] [--config <file> ...]\n',
    );
    return 2;
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`evidence cli failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
