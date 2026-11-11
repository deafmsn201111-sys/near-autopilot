import { randomBytes } from 'node:crypto';
import { accountId } from '@near-autopilot/core';
import {
  createDatabase,
  llmCalls,
  llmSettings,
  runMigrations,
  sql,
  type DatabaseHandle,
} from '@near-autopilot/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmCallRecord } from '../src/analytics/ai-analysis';
import { DrizzleLlmLedger } from '../src/analytics/llm-ledger';

/** The LLM spend ledger on a real PostgreSQL (skipped unless DATABASE_TEST_URL is set; CI sets it). */
const adminUrl = process.env['DATABASE_TEST_URL'];
const NOW = new Date('2026-11-12T10:00:00Z');

const call = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  at: NOW,
  accountId: accountId('alice.near'),
  model: 'claude-haiku-5-5',
  inputTokens: 2000,
  outputTokens: 200,
  costMicroUsd: 300n,
  latencyMs: 1500,
  tools: ['liquidation_guardian'],
  outcome: 'ok',
  ...over,
});

describe.skipIf(!adminUrl)('DrizzleLlmLedger (PostgreSQL)', () => {
  const dbName = `autopilot_llm_${randomBytes(6).toString('hex')}`;
  let admin: DatabaseHandle;
  let handle: DatabaseHandle;
  const ledger = (defaultCapMicro = 5_000_000n) =>
    new DrizzleLlmLedger(handle.db, defaultCapMicro, () => NOW);

  beforeAll(async () => {
    admin = createDatabase(adminUrl ?? '', { max: 1 });
    await admin.db.execute(sql.raw(`CREATE DATABASE "${dbName}"`));
    const url = new URL(adminUrl ?? '');
    url.pathname = `/${dbName}`;
    handle = createDatabase(url.toString(), { max: 2 });
    await runMigrations(handle.db);
  });

  afterAll(async () => {
    await handle.close();
    await admin.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${dbName}"`));
    await admin.close();
  });

  beforeEach(async () => {
    await handle.db.delete(llmCalls);
    await handle.db.delete(llmSettings);
  });

  it('stores a call with its numbers and nothing else', async () => {
    await ledger().record(call());
    const rows = await handle.db.select().from(llmCalls);
    expect(rows).toMatchObject([
      {
        accountId: 'alice.near',
        model: 'claude-haiku-5-5',
        inputTokens: 2000,
        outputTokens: 200,
        costMicroUsd: 300n,
        latencyMs: 1500,
        tools: ['liquidation_guardian'],
        outcome: 'ok',
      },
    ]);
  });

  it('leaves the default cap minus what was spent since UTC midnight', async () => {
    await ledger().record(call({ costMicroUsd: 1_000n }));
    await ledger().record(call({ at: new Date('2026-11-12T00:00:00Z'), costMicroUsd: 2_000n }));
    await ledger().record(call({ at: new Date('2026-11-11T23:59:59Z'), costMicroUsd: 9_999n }));
    expect(await ledger().remainingTodayMicro()).toBe(5_000_000n - 3_000n);
  });

  it('takes the cap from the settings row when one is set', async () => {
    await handle.db
      .insert(llmSettings)
      .values({ id: 1, dailyCapMicroUsd: 10_000n, updatedAt: NOW });
    await ledger().record(call({ costMicroUsd: 12_000n }));
    expect(await ledger().remainingTodayMicro()).toBe(-2_000n);
  });

  it('falls back to the env cap when the settings cap is null', async () => {
    await handle.db.insert(llmSettings).values({ id: 1, dailyCapMicroUsd: null, updatedAt: NOW });
    expect(await ledger(7n).remainingTodayMicro()).toBe(7n);
  });

  it('deletes calls older than 7 days', async () => {
    await ledger().record(call({ at: new Date('2026-11-05T09:59:59Z') }));
    await ledger().record(call({ at: new Date('2026-11-05T10:00:01Z') }));
    await ledger().purge();
    const rows = await handle.db.select({ at: llmCalls.at }).from(llmCalls);
    expect(rows.map((r) => r.at.toISOString())).toEqual(['2026-11-05T10:00:01.000Z']);
  });

  it('rejects an outcome outside the enum', async () => {
    await expect(
      handle.db.execute(
        sql`insert into llm_calls (at, account_id, model, input_tokens, output_tokens, cost_micro_usd, latency_ms, tools, outcome)
            values (now(), 'a.near', 'm', 0, 0, 0, 0, '[]', 'whatever')`,
      ),
    ).rejects.toThrow();
  });
});
