import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@near-autopilot/db';
import { policyConfigSchema } from '@near-autopilot/policy-engine';
import { z } from 'zod';
import { DrizzleRepository } from '../infra/drizzle-repository';
import { allDefended, FIXTURE_LABEL, runAttacks } from './attack';

/**
 * pnpm demo:attack [--out <file>] [--persist]
 *
 * Runs every attack fixture against the real defences, prints a table, and writes the log to
 * docs/evidence/demo-attack.log.jsonl (deterministic: the committed file is what a clean clone produces).
 * --persist ALSO stores the policy verdicts and one audit event per attack in Postgres (DATABASE_URL), as
 * simulation/testnet rows whose run id starts with `demo-attack:` and whose intents are labelled FIXTURE, so the
 * dashboard and `audit:replay` can show them. Nothing is sent to any chain. Exit 1 if any attack got through.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const LOG_FILE = resolve(ROOT, 'docs/evidence/demo-attack.log.jsonl');
const CONFIG_FILE = resolve(ROOT, 'config/autopilot.testnet.example.json');

export function attackPolicy() {
  const json = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { policy?: unknown };
  return policyConfigSchema.parse(json.policy);
}

export const toLog = (entries: readonly unknown[]): string =>
  entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

async function main(): Promise<number> {
  const persist = process.argv.includes('--persist');
  const { entries, verdicts } = await runAttacks(attackPolicy());
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1] ?? LOG_FILE) : LOG_FILE;
  let written: string | null = null;
  try {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, toLog(entries));
    written = out;
  } catch (e) {
    // e.g. inside the container (read-only source tree for the unprivileged user): say so, never pretend it was saved.
    process.stderr.write(
      `log NOT written to ${out}: ${e instanceof Error ? e.message : String(e)} (use --out <path>)\n`,
    );
  }

  process.stdout.write(`\n${FIXTURE_LABEL}\n\n`);
  for (const e of entries)
    process.stdout.write(
      `${e.outcome.padEnd(11)} ${e.attack.padEnd(31)} ${e.defence}\n${' '.repeat(12)}${e.failed.join(', ') || '-'}\n`,
    );
  const ok = allDefended(entries);
  const attacks = entries.filter((e) => e.kind === 'attack');
  process.stdout.write(
    `\n${attacks.filter((e) => e.outcome !== 'NOT_BLOCKED').length}/${attacks.length} attacks stopped, ` +
      `${entries.length - attacks.length} controls allowed, signed ${entries.reduce((s, e) => s + e.signed, 0)}, ` +
      `broadcast ${entries.reduce((s, e) => s + e.broadcast, 0)}. Log: ${written ?? 'not written'}\n`,
  );

  if (persist) {
    const { DATABASE_URL } = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
    const database = createDatabase(DATABASE_URL, { max: 2 });
    try {
      const repo = new DrizzleRepository(database.db, {
        dataSource: 'simulation',
        network: 'testnet',
      });
      const stamp = new Date().toISOString();
      for (const v of verdicts)
        await repo.insertPolicyVerdict({ ...v, id: `demo-attack:${stamp}:${v.id}` });
      for (const e of entries)
        await repo.appendAudit({
          at: new Date(),
          type: `demo_attack.${e.outcome.toLowerCase()}`,
          runId: `demo-attack:${stamp}`,
          proposalId: null,
          payload: e,
        });
      process.stdout.write(
        `Persisted ${verdicts.length} verdicts and ${entries.length} audit events (run demo-attack:${stamp}).\n`,
      );
    } finally {
      await database.close();
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`demo:attack failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
