import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmModel } from '@near-autopilot/config';
import { accountId } from '@near-autopilot/core';
import { createDatabase } from '@near-autopilot/db';
import { NearRpcClient } from '@near-autopilot/near-adapter';
import { stripFence, type ToolLlm } from '@near-autopilot/orchestrator';
import Fastify from 'fastify';
import { z } from 'zod';
import { CollectorStore } from '../collector/store';
import { registerAccountView } from '../analytics/account-view';
import { analyseAccount, analysisMemo, type LlmCallRecord } from '../analytics/ai-analysis';
import { AnthropicToolLlm, type AnthropicLlmConfig } from './anthropic-client';

/**
 * MODEL COMPARISON (issue #16; not part of the server). Runs the real analysis (tool-use loop) on mainnet accounts
 * with each config, RUNS times, and prints cost, latency, outcome and picks. Reads the chain and the local
 * collector's prices; spends real Anthropic credit and stops before MAX_SPEND_USD.
 *
 *   node --env-file=../../.env --import tsx src/llm/compare-models.ts autopilot-test.near hodl13.near
 *
 * The ownership proof is skipped on purpose: this runs on the owner's machine with the owner's key, never as a route.
 */
const CONFIGS: readonly {
  label: string;
  model: LlmModel;
  effort?: AnthropicLlmConfig['effort'];
}[] = [
  { label: 'haiku-5.5 default', model: 'claude-haiku-5-5' },
  { label: 'sonnet-5.5 low', model: 'claude-sonnet-5-5', effort: 'low' },
  { label: 'sonnet-5.5 default', model: 'claude-sonnet-5-5' },
];
const RUNS = 3;
const MAX_TOKENS = 4096;
const MAX_SPEND_USD = 2;

const env = z
  .object({
    ANTHROPIC_API_KEY: z.string().min(8),
    DATABASE_URL: z.string().url(),
    MAINNET_READ_RPC_URL: z.string().url(),
    MAINNET_READ_RPC_API_KEY: z.string().optional(),
    MARKET_CONFIG_FILE: z.string().default('../../config/market.json'),
    COMPARE_OUT: z.string().default('compare-models.json'),
  })
  .parse(process.env);
const accounts = process.argv.slice(2).map((a) => accountId(a));
if (accounts.length === 0) throw new Error('usage: compare-models.ts <account.near> [...]');

const pools =
  (
    JSON.parse(readFileSync(env.MARKET_CONFIG_FILE, 'utf8')) as {
      rhea?: { pools?: { poolId: number; tokenA: string; tokenB: string }[] };
    }
  ).rhea?.pools ?? [];
const database = createDatabase(env.DATABASE_URL, { max: 2 });
const app = Fastify({ logger: false });
const { analysisInputs } = registerAccountView(app, new CollectorStore(database.db), {
  rpc: new NearRpcClient({
    url: env.MAINNET_READ_RPC_URL,
    headers: env.MAINNET_READ_RPC_API_KEY
      ? { authorization: `Bearer ${env.MAINNET_READ_RPC_API_KEY}` }
      : undefined,
    maxConcurrent: 4,
  }),
  burrowId: accountId('contract.main.burrow.near'),
  rheaId: accountId('v2.ref-finance.near'),
  dclId: accountId('dclv2.ref-labs.near'),
  pools: pools.map((p) => ({
    poolId: p.poolId,
    tokenA: accountId(p.tokenA),
    tokenB: accountId(p.tokenB),
  })),
});
const sdk = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 0 });

let spentMicro = 0n;
let calls: LlmCallRecord[] = [];
const budgetLeft = () => BigInt(MAX_SPEND_USD * 1e6) - spentMicro;
const ledger = {
  remainingTodayMicro: async () => budgetLeft(),
  record: async (call: LlmCallRecord) => {
    spentMicro += call.costMicroUsd;
    calls.push(call);
  },
};

/** Counts the model turns and keeps the final text, so the "why" texts the numbers check replaced can be counted. */
function observed(llm: ToolLlm) {
  const seen = { turns: 0, final: '' };
  const wrapped: ToolLlm = {
    open: (request) => {
      const chat = llm.open(request);
      return {
        send: async (results) => {
          seen.turns++;
          const turn = await chat.send(results);
          if (turn.kind === 'final') seen.final = turn.text;
          return turn;
        },
      };
    },
  };
  return { wrapped, seen };
}

const picksSchema = z.object({ picks: z.array(z.object({ id: z.string(), why: z.string() })) });

function proposedWhys(text: string): Map<string, string> {
  try {
    const parsed = picksSchema.safeParse(JSON.parse(stripFence(text)));
    return new Map(parsed.success ? parsed.data.picks.map((p) => [p.id, p.why]) : []);
  } catch {
    return new Map();
  }
}

const say = (line: string) => process.stdout.write(`${line}\n`);
const usd = (micro: bigint) => Number(micro) / 1e6;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

const rows: Record<string, unknown>[] = [];
measure: for (const account of accounts) {
  const inputs = await analysisInputs(account, app.log);
  if ('error' in inputs) {
    console.warn(`${account}: ${inputs.error}; skipped`);
    continue;
  }
  say(`\n${account}: rule-based list ${inputs.heuristics.map((h) => h.kind).join(', ')}`);
  for (const config of CONFIGS) {
    for (let run = 1; run <= RUNS; run++) {
      if (budgetLeft() <= 0n) {
        console.warn(`spend limit $${MAX_SPEND_USD} reached; stopping`);
        break measure;
      }
      calls = [];
      const { wrapped, seen } = observed(
        new AnthropicToolLlm(sdk, {
          model: config.model,
          maxTokens: MAX_TOKENS,
          effort: config.effort,
        }),
      );
      const started = Date.now();
      const analysis = await analyseAccount(
        { llm: wrapped, model: config.model, maxTokens: MAX_TOKENS, ledger, memo: analysisMemo() },
        { ...inputs, ownerVerified: true },
        (e) =>
          console.warn(`  ${config.label} #${run}: ${e instanceof Error ? e.message : String(e)}`),
      );
      const call = calls[0];
      const whys = proposedWhys(seen.final);
      const replaced = analysis.recommendations.filter(
        (r) => whys.has(r.id) && whys.get(r.id) !== r.why,
      ).length;
      const row = {
        account,
        config: config.label,
        run,
        source: analysis.source,
        fallback: analysis.fallback,
        costUsd: call ? usd(call.costMicroUsd) : 0,
        inputTokens: call?.inputTokens ?? 0,
        outputTokens: call?.outputTokens ?? 0,
        latencyMs: call?.latencyMs ?? Date.now() - started,
        turns: seen.turns,
        replaced,
        warningFirst:
          !analysis.recommendations.some((r) => r.severity === 'warning') ||
          analysis.recommendations[0]?.severity === 'warning',
        picks: analysis.recommendations.map((r) => ({ id: r.id, title: r.title, why: r.why })),
        rawFinal: seen.final,
      };
      rows.push(row);
      writeFileSync(env.COMPARE_OUT, JSON.stringify(rows, null, 2));
      say(
        `  ${config.label} #${run}: ${row.source}${row.fallback ? ` (${row.fallback})` : ''}, $${row.costUsd.toFixed(4)}, ${(row.latencyMs / 1000).toFixed(1)} s, ${row.turns} turns, ${replaced} why replaced`,
      );
      for (const p of row.picks) say(`      - ${p.title} — ${p.why}`);
    }
  }
}

say('\naccount | config | $/analysis | p50 s | llm ok | why replaced | warning first');
for (const account of accounts)
  for (const config of CONFIGS) {
    const rs = rows.filter((r) => r.account === account && r.config === config.label);
    if (rs.length === 0) continue;
    const cost = rs.reduce((s, r) => s + (r.costUsd as number), 0) / rs.length;
    say(
      [
        account,
        config.label,
        `$${cost.toFixed(4)}`,
        (median(rs.map((r) => r.latencyMs as number)) / 1000).toFixed(1),
        `${rs.filter((r) => r.source === 'llm').length}/${rs.length}`,
        rs.reduce((s, r) => s + (r.replaced as number), 0),
        `${rs.filter((r) => r.warningFirst).length}/${rs.length}`,
      ].join(' | '),
    );
  }
say(`\ntotal spend $${usd(spentMicro).toFixed(4)}; raw runs in ${env.COMPARE_OUT}`);
await database.close();
