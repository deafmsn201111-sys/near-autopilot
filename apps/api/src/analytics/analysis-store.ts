import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { accountAnalyses, and, eq, lt, type Database } from '@near-autopilot/db';
import type { AccountId } from '@near-autopilot/core';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { z } from 'zod';
import type { Analysis, AnalysisStore, SavedAnalysis } from './ai-analysis';

export const ANALYSES_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** 32-byte AES-256-GCM key as 64 hex characters (quickstart.sh / deploy setup.sh generate it). */
export const analysisKeySchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be 64 hex characters (openssl rand -hex 32)')
  .transform((hex) => Buffer.from(hex, 'hex'));

// A full 16-byte tag only: without authTagLength Node also accepts truncated tags, which are easier to forge.
const GCM = { authTagLength: 16 } as const;

const sealedSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
});
export type SealedAnalysis = z.infer<typeof sealedSchema>;

/** The binding (account + strategy) is the GCM associated data: a row copied to another account does not open. */
export function sealAnalysis(key: Buffer, binding: string, payload: unknown): SealedAnalysis {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, GCM).setAAD(Buffer.from(binding));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Null for anything that is not a row sealed under this key and binding (plaintext, rotated key, tampered). */
export function openAnalysis(key: Buffer, binding: string, stored: unknown): unknown {
  const sealed = sealedSchema.safeParse(stored);
  if (!sealed.success) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(sealed.data.iv, 'base64'),
      GCM,
    )
      .setAAD(Buffer.from(binding))
      .setAuthTag(Buffer.from(sealed.data.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(sealed.data.ct, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
}

const bindingOf = (accountId: AccountId, strategy: StrategyId) => `${accountId}/${strategy}`;

/** PostgreSQL store of the last AI analysis per account and strategy (migration 0025), encrypted at rest (#278). */
export class DrizzleAnalysisStore implements AnalysisStore {
  constructor(
    private readonly db: Database,
    private readonly key: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async latest(accountId: AccountId, strategy: StrategyId): Promise<SavedAnalysis | null> {
    const [row] = await this.db
      .select()
      .from(accountAnalyses)
      .where(and(eq(accountAnalyses.accountId, accountId), eq(accountAnalyses.strategy, strategy)));
    const analysis = row && openAnalysis(this.key, bindingOf(accountId, strategy), row.analysis);
    return row && analysis
      ? {
          key: row.analysisKey,
          signature: row.signature,
          at: row.at,
          analysis: analysis as Analysis,
        }
      : null;
  }

  async save(accountId: AccountId, strategy: StrategyId, saved: SavedAnalysis): Promise<void> {
    const row = {
      analysisKey: saved.key,
      signature: saved.signature,
      at: saved.at,
      analysis: sealAnalysis(this.key, bindingOf(accountId, strategy), saved.analysis),
    };
    await this.db
      .insert(accountAnalyses)
      .values({ accountId, strategy, ...row })
      .onConflictDoUpdate({
        target: [accountAnalyses.accountId, accountAnalyses.strategy],
        set: row,
      });
  }

  async purge(): Promise<void> {
    await this.db
      .delete(accountAnalyses)
      .where(lt(accountAnalyses.at, new Date(this.now().getTime() - ANALYSES_KEEP_MS)));
  }
}
