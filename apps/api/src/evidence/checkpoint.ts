import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { and, auditCheckpoints, auditEvents, desc, eq, type Database } from '@near-autopilot/db';

/**
 * SIGNED AUDIT CHECKPOINTS: an anchor for the hash chain OUTSIDE the database.
 *
 * The chain in `audit_events` proves that no entry was changed relative to its neighbours, but someone with write
 * access to the whole database could rewrite the chain and recompute every hash, or delete its newest entries. A
 * checkpoint is a statement "chain C had entry SEQ with hash H at time T", signed with an ed25519 key that is kept in
 * the environment (.env), never in the database. Checkpoints go to an append-only table AND to a JSONL file outside the
 * database volume. Verification needs only the PUBLIC key:
 *   - signature valid                     -> the statement was made by the key holder
 *   - entry SEQ still has hash H          -> nothing up to SEQ was rewritten
 *   - the chain still reaches SEQ         -> its tail was not cut
 * What it cannot catch: an attacker who also has the private key, or a rewrite of entries written after the last
 * checkpoint (one collector interval). Anchoring the head on NEAR itself is the next step (ROADMAP).
 */
export interface Checkpoint {
  readonly chain: string;
  readonly seq: number;
  readonly hash: string;
  readonly at: string;
  readonly publicKey: string;
  readonly signature: string;
}

const message = (c: Pick<Checkpoint, 'chain' | 'seq' | 'hash' | 'at'>) =>
  Buffer.from(`near-autopilot audit checkpoint v1|${c.chain}|${c.seq}|${c.hash}|${c.at}`, 'utf8');

/** Raw 32-byte keys as hex, from/to Node key objects (PKCS8 / SPKI DER prefixes for ed25519). */
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
export const privateKeyFromHex = (hex: string): KeyObject =>
  createPrivateKey({
    key: Buffer.concat([PKCS8, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
export const publicKeyFromHex = (hex: string): KeyObject =>
  createPublicKey({
    key: Buffer.concat([SPKI, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
export const publicHexOf = (key: KeyObject): string =>
  createPublicKey(key)
    .export({ format: 'der', type: 'spki' })
    .subarray(SPKI.length)
    .toString('hex');

/** A new key pair (hex). Used by scripts/quickstart.sh through `cli.ts checkpoint-keygen`. */
export function generateCheckpointKey(): { privateHex: string; publicHex: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const der = privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    privateHex: der.subarray(PKCS8.length).toString('hex'),
    publicHex: publicHexOf(privateKey),
  };
}

export function signCheckpoint(
  c: Pick<Checkpoint, 'chain' | 'seq' | 'hash' | 'at'>,
  privateHex: string,
): Checkpoint {
  const key = privateKeyFromHex(privateHex);
  return {
    ...c,
    publicKey: publicHexOf(key),
    signature: sign(null, message(c), key).toString('hex'),
  };
}

export function signatureValid(c: Checkpoint, publicHex: string): boolean {
  try {
    return (
      c.publicKey === publicHex &&
      verify(null, message(c), publicKeyFromHex(publicHex), Buffer.from(c.signature, 'hex'))
    );
  } catch {
    return false;
  }
}

/** Signs the current head of every chain that moved since its last checkpoint. Returns the new checkpoints. */
export async function checkpointAll(
  db: Database,
  privateHex: string,
  opts: { file?: string; now?: () => Date } = {},
): Promise<Checkpoint[]> {
  const heads = await db
    .selectDistinctOn([auditEvents.chain], {
      chain: auditEvents.chain,
      seq: auditEvents.seq,
      hash: auditEvents.hash,
    })
    .from(auditEvents)
    .orderBy(auditEvents.chain, desc(auditEvents.seq));
  const made: Checkpoint[] = [];
  for (const h of heads) {
    if (!h.chain || !h.seq || !h.hash) continue;
    const [last] = await db
      .select({ seq: auditCheckpoints.seq })
      .from(auditCheckpoints)
      .where(eq(auditCheckpoints.chain, h.chain))
      .orderBy(desc(auditCheckpoints.seq))
      .limit(1);
    if (last && last.seq >= h.seq) continue;
    const c = signCheckpoint(
      { chain: h.chain, seq: h.seq, hash: h.hash, at: (opts.now?.() ?? new Date()).toISOString() },
      privateHex,
    );
    await db
      .insert(auditCheckpoints)
      .values({ ...c, at: new Date(c.at) })
      .onConflictDoNothing();
    if (opts.file) {
      mkdirSync(dirname(opts.file), { recursive: true });
      appendFileSync(opts.file, `${JSON.stringify(c)}\n`);
    }
    made.push(c);
  }
  return made;
}

export interface CheckpointCheck {
  readonly chain: string;
  readonly checkpoints: number;
  readonly latest: { seq: number; at: string } | null;
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Verifies checkpoints against the CURRENT chain, with a pinned public key (from the environment, never from the
 * database). The file, when given, is the authoritative copy: a checkpoint deleted from the table but present in the
 * file is still checked, and one in the table but not in the file is reported.
 */
export async function verifyCheckpoints(
  db: Database,
  publicHex: string,
  opts: { file?: string } = {},
): Promise<CheckpointCheck[]> {
  const fromTable: Checkpoint[] = (
    await db.select().from(auditCheckpoints).orderBy(auditCheckpoints.chain, auditCheckpoints.seq)
  ).map((r) => ({
    chain: r.chain,
    seq: r.seq,
    hash: r.hash,
    at: r.at.toISOString(),
    publicKey: r.publicKey,
    signature: r.signature,
  }));
  const fromFile: Checkpoint[] =
    opts.file && existsSync(opts.file)
      ? readFileSync(opts.file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Checkpoint)
      : [];
  const key = (c: Checkpoint) => `${c.chain}|${c.seq}|${c.hash}|${c.signature}`;
  const all = new Map<string, Checkpoint>();
  for (const c of [...fromFile, ...fromTable]) all.set(key(c), c);
  const fileKeys = new Set(fromFile.map(key));
  const chains = [...new Set([...all.values()].map((c) => c.chain))].sort();
  const out: CheckpointCheck[] = [];
  for (const chain of chains) {
    const list = [...all.values()].filter((c) => c.chain === chain).sort((a, b) => a.seq - b.seq);
    const problems: string[] = [];
    const [head] = await db
      .select({ seq: auditEvents.seq })
      .from(auditEvents)
      .where(eq(auditEvents.chain, chain))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    for (const c of list) {
      if (!signatureValid(c, publicHex)) {
        problems.push(`checkpoint at seq ${c.seq}: signature invalid or made with another key`);
        continue;
      }
      if (opts.file && fromFile.length > 0 && !fileKeys.has(key(c)))
        problems.push(
          `checkpoint at seq ${c.seq} is in the database but not in the checkpoint file`,
        );
      if ((head?.seq ?? 0) < c.seq) {
        problems.push(
          `the chain ends at seq ${head?.seq ?? 0}, but seq ${c.seq} was checkpointed: its tail was cut`,
        );
        continue;
      }
      const [entry] = await db
        .select({ hash: auditEvents.hash })
        .from(auditEvents)
        .where(and(eq(auditEvents.chain, chain), eq(auditEvents.seq, c.seq)))
        .limit(1);
      if (entry?.hash !== c.hash)
        problems.push(
          `entry ${c.seq} no longer has the checkpointed hash: the chain was rewritten`,
        );
    }
    const latest = list[list.length - 1];
    out.push({
      chain,
      checkpoints: list.length,
      latest: latest ? { seq: latest.seq, at: latest.at } : null,
      ok: problems.length === 0,
      problems,
    });
  }
  return out;
}
