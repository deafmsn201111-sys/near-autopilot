'use client';
import type { StrategyId } from '@near-autopilot/core/strategy';
import { z } from 'zod';
import type { AccountRecommendation } from './product';

const intentSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('repay'),
    token: z.string(),
    approxUsd: z.number(),
    amount: z.string().regex(/^\d+$/).optional(),
  }),
  z.object({
    action: z.literal('supply'),
    token: z.string(),
    approxUsd: z.number(),
    amount: z.string().regex(/^\d+$/).optional(),
  }),
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
      intent: intentSchema,
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
