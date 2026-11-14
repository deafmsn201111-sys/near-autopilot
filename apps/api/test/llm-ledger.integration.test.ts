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
import { llmQuality, windowStart } from '../src/analytics/admin';
import { DrizzleLlmLedger } from '../src/analytics/llm-ledger';

/** The LLM spend ledger on a real PostgreSQL (skipped unless DATABASE_TEST_URL is set; CI sets it). */
const adminUrl = process.env['DATABASE_TEST_URL'];
const NOW = new Date('2026-11-12T10:00:00Z');

const call = (over: Partial<LlmCallRecord> = {}): LlmCallRecord => ({
  at: NOW,
  accountId: accountId('alice.near'),
  model: 'z-ai/glm-5.3-flash',
  inputTokens: 2000,
  outputTokens: 200,
  costMicroUsd: 300n,
  latencyMs: 1500,
  tools: ['liquidation_guardian'],
  outcome: 'ok',
  input: { strategy: 'balanced', candidates: [{ id: 'a', kind: 'improve_loan_safety' }] },
  privacy: null,
  output: { picks: [{ id: 'a', kind: 'improve_loan_safety', why: 'Repay.' }] },
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
        model: 'z-ai/glm-5.3-flash',
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

  it('reads LLM on and no settings before the row exists', async () => {
    expect(await ledger().enabled()).toBe(true);
    expect(await ledger().settings()).toEqual({
      dailyCapMicroUsd: null,
      llmEnabled: true,
      depositMicroUsd: null,
      depositSetAt: null,
    });
  });

  it('saves the kill switch, cap and deposit, keeping the fields a patch leaves out', async () => {
    await ledger().saveSettings({ llmEnabled: false });
    expect(await ledger().enabled()).toBe(false);
    await ledger().saveSettings({
      dailyCapMicroUsd: 2_000_000n,
      depositMicroUsd: 9_000_000n,
      depositSetAt: NOW,
    });
    expect(await ledger().settings()).toEqual({
      dailyCapMicroUsd: 2_000_000n,
      llmEnabled: false,
      depositMicroUsd: 9_000_000n,
      depositSetAt: NOW,
    });
    expect(await ledger().remainingTodayMicro()).toBe(2_000_000n);
    await ledger().saveSettings({ llmEnabled: true });
    expect(await ledger().enabled()).toBe(true);
  });

  it('rejects a deposit of zero', async () => {
    await expect(
      ledger().saveSettings({ depositMicroUsd: 0n, depositSetAt: NOW }),
    ).rejects.toThrow();
  });

  it('lists the calls since a time with model and cost', async () => {
    await ledger().record(call({ costMicroUsd: 1_000n }));
    await ledger().record(call({ at: new Date('2026-11-01T00:00:00Z') }));
    expect(await ledger().recentCalls(new Date('2026-11-06T00:00:00Z'))).toEqual([
      { at: NOW, model: 'z-ai/glm-5.3-flash', costMicroUsd: 1_000n },
    ]);
  });

  const quality = async () => llmQuality(await ledger().quality(windowStart(NOW), NOW));

  it('gives fallback and validation-error rates, p50/p95 latency and top recommendation kinds', async () => {
    const rows: Partial<LlmCallRecord>[] = [
      { latencyMs: 1000 },
      {
        latencyMs: 2000,
        output: {
          picks: [
            { id: 'a', kind: 'improve_loan_safety', why: 'a' },
            { id: 'b', kind: 'put_idle_to_work', why: 'b' },
          ],
        },
      },
      { latencyMs: 3000, outcome: 'invalid_output', output: { reply: 'nope' } },
      { latencyMs: 4000, outcome: 'deadline', output: null },
      { latencyMs: 5000, outcome: 'invalid_output', output: null },
      { at: new Date('2026-11-05T23:59:59Z'), outcome: 'deadline' },
      { at: new Date('2026-11-12T10:00:01Z'), outcome: 'deadline' },
    ];
    for (const over of rows) await ledger().record(call(over));
    const q = await quality();
    expect(q.calls).toBe(5);
    expect(q.fallbackRate).toBe(0.6);
    expect(q.validationErrorRate).toBe(0.4);
    expect(q.fallbacks).toEqual([
      { code: 'invalid_output', count: 2, rate: 0.4 },
      { code: 'deadline', count: 1, rate: 0.2 },
    ]);
    expect(q.p50Ms).toBe(3000);
    expect(q.p95Ms).toBe(4800);
    expect(q.topKinds).toEqual([
      { kind: 'improve_loan_safety', count: 2 },
      { kind: 'put_idle_to_work', count: 1 },
    ]);
  });

  it('lists the 20 newest runs, newest first, with input, output and agents called', async () => {
    for (let i = 0; i < 25; i++)
      await ledger().record(call({ at: new Date(Date.UTC(2026, 10, 12, 0, i)), latencyMs: i }));
    const q = await quality();
    expect(q.last).toHaveLength(20);
    expect(q.last[0]).toEqual({
      at: '2026-11-12T00:24:00.000Z',
      accountId: 'alice.near',
      model: 'z-ai/glm-5.3-flash',
      latencyMs: 24,
      outcome: 'ok',
      tools: ['liquidation_guardian'],
      input: call().input,
      output: call().output,
    });
    expect(q.last[19]?.latencyMs).toBe(5);
  });

  it('has no rates or percentiles without runs in the 7 days', async () => {
    await ledger().record(call({ at: new Date('2026-11-05T23:59:59Z') }));
    expect(await quality()).toEqual({
      calls: 0,
      fallbackRate: null,
      validationErrorRate: null,
      p50Ms: null,
      p95Ms: null,
      fallbacks: [],
      topKinds: [],
      last: [],
    });
  });

  it('ignores an output that is not the picks shape', async () => {
    for (const output of [
      { picks: 'all' },
      7,
      'text',
      { picks: [{ id: 'x', kind: null, why: 'w' }, 'pick', { kind: 3 }] },
    ])
      await ledger().record(call({ output: output as unknown as LlmCallRecord['output'] }));
    expect((await quality()).topKinds).toEqual([]);
  });

  it('deletes calls older than 7 days', async () => {
    await ledger().record(call({ at: new Date('2026-11-05T09:59:59Z') }));
    await ledger().record(call({ at: new Date('2026-11-05T10:00:01Z') }));
    await ledger().purge();
    const rows = await handle.db.select({ at: llmCalls.at }).from(llmCalls);
    expect(rows.map((r) => r.at.toISOString())).toEqual(['2026-11-05T10:00:01.000Z']);
  });

  it('stores a run the visitor cancelled', async () => {
    await ledger().record(call({ outcome: 'cancelled' }));
    expect(await handle.db.select().from(llmCalls)).toMatchObject([{ outcome: 'cancelled' }]);
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
