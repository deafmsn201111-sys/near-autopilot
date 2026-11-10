import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policyConfigSchema } from '@near-autopilot/policy-engine';
import { allDefended, FIXTURE_LABEL, runAttacks } from './attack';

/**
 * pnpm demo:attack [--out <file>]
 *
 * Runs every attack fixture against the real defences, prints a table, and writes the log to
 * docs/evidence/demo-attack.log.jsonl (deterministic: the committed file is what a clean clone produces).
 * Nothing is written to a database (fixtures never enter a deployment's audit chain) and nothing is sent to any
 * chain. Exit 1 if any attack got through.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const LOG_FILE = resolve(ROOT, 'docs/evidence/demo-attack.log.jsonl');
const WNEAR = 'wrap.near';
const USDT = 'usdt.tether-token.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const RHEA = 'v2.ref-finance.near';
const BURROW = 'contract.main.burrow.near';

/** The fixed fixture policy the attacks run against, over the mainnet ids above. */
export function attackPolicy() {
  return policyConfigSchema.parse({
    enabled: true,
    signerAccountId: 'your-account.near',
    allowedContracts: [WNEAR, USDT, USDC, RHEA, BURROW],
    allowedRecipients: [RHEA, BURROW],
    allowedTokens: [WNEAR, USDT, USDC],
    allowedMethods: ['ft_transfer_call'],
    maxActionUsd: 100,
    dailyLimitUsd: 300,
    approvalThresholdUsd: 50,
    maxSlippageBps: 50,
    maxOracleDeviationBps: 150,
    maxPriceAgeSeconds: 180,
    cooldownSeconds: 600,
    approvalTtlSeconds: 120,
  });
}

export const toLog = (entries: readonly unknown[]): string =>
  entries.map((e) => JSON.stringify(e)).join('\n') + '\n';

async function main(): Promise<number> {
  const { entries } = await runAttacks(attackPolicy());
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
