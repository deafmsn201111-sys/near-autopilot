'use client';
import { PROVENANCE_TIERS } from '@near-autopilot/core';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { z } from 'zod';
import type { AccountRecommendation } from './product';

const positive = z.number().positive();
const sizingSchema = z.object({
  collateralAdjUsd: z.number().nonnegative(),
  debtAdjUsd: z.number().nonnegative(),
  vr: positive.max(1),
  usdPerToken: positive,
  symbol: z.string().max(64),
  decimals: z.number().int().min(0).max(30),
  hfNow: z.number().nonnegative(),
  targetHf: positive,
  safeTokens: z.number().nonnegative(),
  maxTokens: z.number().nonnegative(),
  wholeDebt: z.boolean(),
});
const burrowIntent = <A extends string>(action: A) =>
  z.object({
    action: z.literal(action),
    token: z.string(),
    approxUsd: z.number(),
    amount: z.string().regex(/^\d+$/).optional(),
    sizing: sizingSchema.optional(),
  });

const intentSchema = z.discriminatedUnion('action', [
  burrowIntent('repay'),
  burrowIntent('repay_from_collateral'),
  burrowIntent('supply'),
  burrowIntent('withdraw'),
  z.object({ action: z.literal('swap'), fromToken: z.string(), approxUsd: z.number() }),
  z.object({ action: z.literal('reposition_dcl'), lptId: z.string(), poolId: z.string() }),
]);

const traceStepSchema = z.object({
  tool: z.string(),
  agent: z.string(),
  ok: z.boolean(),
  text: z.string(),
  // A tier this build does not know drops only the label, not the whole analysis.
  provenance: z.enum(PROVENANCE_TIERS).nullable().catch(null),
  pick: z.enum(['ranked', 'kept', 'left_out']).nullable().catch(null),
  rank: z.number().int().positive().nullable().catch(null),
});

const runSchema = z.object({
  model: z.string(),
  turns: z.number(),
  toolCalls: z.number(),
  ms: z.number(),
  read: z.object({ tokens: z.number(), loan: z.boolean() }),
  checks: z.object({
    picked: z.number(),
    explained: z.number(),
    replaced: z.number(),
    restored: z.number(),
    dropped: z.number(),
  }),
});

export type TraceStep = z.infer<typeof traceStepSchema>;

const analysisSchema = z.object({
  source: z.enum(['llm', 'heuristic']),
  fallback: z.string().nullish(),
  note: z.string().nullable(),
  recommendations: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      agent: z.string(),
      severity: z.enum(['info', 'warning']),
      title: z.string(),
      why: z.string(),
      intent: intentSchema.nullable(),
      carry: z
        .object({ text: z.string(), provenance: z.literal('calculated_estimate') })
        .optional()
        .catch(undefined),
    }),
  ),
  calledTools: z.array(z.string()).default([]),
  trace: z.array(traceStepSchema).default([]),
  run: runSchema.nullable().catch(null),
});

export type Analysis = {
  source: 'llm' | 'heuristic';
  fallback?: string | null;
  note: string | null;
  recommendations: AccountRecommendation[];
  calledTools: string[];
  trace: TraceStep[];
  run: z.infer<typeof runSchema> | null;
};

export async function runAnalysis(
  account: string,
  strategy: StrategyId,
): Promise<{ ok: true; analysis: Analysis } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch('/api/analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, strategy }),
    });
  } catch {
    return { ok: false, error: 'network error' };
  }
  const json: unknown = await res.json().catch(() => ({}));
  const parsed = analysisSchema.safeParse(json);
  if (res.ok && parsed.success) return { ok: true, analysis: parsed.data };
  const error = (json as { error?: unknown } | null)?.error;
  return {
    ok: false,
    error: typeof error === 'string' ? error : `analysis failed (HTTP ${res.status})`,
  };
}

/** "claude-haiku-5-5" → "Claude Haiku 5.5"; any other id is shown as is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return m ? `Claude ${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} ${m[2]}.${m[3]}` : id;
}
