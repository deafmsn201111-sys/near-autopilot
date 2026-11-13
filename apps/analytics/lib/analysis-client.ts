'use client';
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

const analysisSchema = z.object({
  source: z.enum(['llm', 'heuristic']),
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
    }),
  ),
});

export type Analysis = {
  source: 'llm' | 'heuristic';
  note: string | null;
  recommendations: AccountRecommendation[];
};

export async function runAnalysis(
  account: string,
): Promise<{ ok: true; analysis: Analysis } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch('/api/analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account }),
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
