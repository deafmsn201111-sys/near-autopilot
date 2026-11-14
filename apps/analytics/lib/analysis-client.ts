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
  z.object({
    action: z.literal('supply_all'),
    tokens: z
      .array(z.object({ token: z.string(), approxUsd: z.number() }))
      .min(2)
      .max(5),
  }),
  z.object({
    action: z.literal('repay_with_collateral'),
    token: z.string(),
    collateralToken: z.string(),
    approxUsd: z.number(),
    amount: z.string().regex(/^\d+$/),
    withdraw: z.string().regex(/^\d+$/).optional(),
    maxSlippageBps: z.number().int(),
    plan: z.object({
      hfNow: z.number(),
      hfAfterWithdraw: z.number(),
      hfAfterRepay: z.number().nullable(),
      floorHf: z.number(),
      transactions: z.number().int(),
    }),
  }),
  z.object({
    action: z.literal('recentre_dcl'),
    lptId: z.string(),
    poolId: z.string(),
    leftPoint: z.number().int(),
    rightPoint: z.number().int(),
  }),
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

const readSchema = z.object({ tokens: z.number(), loan: z.boolean() });
const checksSchema = z.object({
  picked: z.number(),
  explained: z.number(),
  replaced: z.number(),
  restored: z.number(),
  dropped: z.number(),
});
const runSchema = z.object({
  model: z.string(),
  turns: z.number(),
  toolCalls: z.number(),
  ms: z.number(),
  read: readSchema,
  checks: checksSchema,
  ranking: z.string().max(300).nullable().catch(null),
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
        .object({
          text: z.string(),
          provenance: z.enum(['calculated_estimate', 'protocol_reported']),
        })
        .optional()
        .catch(undefined),
    }),
  ),
  calledTools: z.array(z.string()).default([]),
  trace: z.array(traceStepSchema).default([]),
  run: runSchema.nullable().catch(null),
  read: readSchema.nullable().catch(null).default(null),
  cachedAt: z.string().nullable().catch(null).default(null),
});

export type Analysis = {
  source: 'llm' | 'heuristic';
  fallback?: string | null;
  note: string | null;
  recommendations: AccountRecommendation[];
  calledTools: string[];
  trace: TraceStep[];
  run: z.infer<typeof runSchema> | null;
  /** What the agents read, also when no model ran. */
  read: z.infer<typeof readSchema> | null;
  cachedAt: string | null;
};

/** The owner's last analysis as the API saved it (#190), with the portfolio signature it was run for. */
export const parseSaved = (raw: unknown): { analysis: Analysis; signature: string } | null => {
  const saved = z.object({ analysis: analysisSchema, signature: z.string() }).safeParse(raw);
  return saved.success ? saved.data : null;
};

/** The run so far, as the "How the AI got here" pipeline shows it; a part is null until its event arrives. */
export type Pipeline = {
  model: string | null;
  read: z.infer<typeof readSchema> | null;
  /** Agents the model called whose answer has not come back yet, plus those that have. */
  asked: AskedAgent[];
  trace: TraceStep[];
  turns: number | null;
  checks: z.infer<typeof checksSchema> | null;
  /** 0 read, 1 agents, 2 ranking, 3 checks, 4 done: the furthest the run has reached, so it never steps back. */
  stage: number;
  /** The model's sentence on why the cards are in this order, checked by code; only in a finished run. */
  ranking: string | null;
};

export const pipelineOf = ({ run, read, trace }: Analysis): Pipeline => ({
  model: run?.model ?? null,
  read: run?.read ?? read,
  asked: trace.map(({ tool, agent }) => ({ tool, agent })),
  trace,
  turns: run?.turns ?? null,
  checks: run?.checks ?? null,
  stage: 4,
  ranking: run?.ranking ?? null,
});

const askedSchema = z.object({ tool: z.string(), agent: z.string() });
type AskedAgent = z.infer<typeof askedSchema>;

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('asked'), agents: z.array(askedSchema).max(20) }),
  readSchema.extend({ type: z.literal('read'), model: z.string() }),
  z.object({ type: z.literal('agent'), step: traceStepSchema }),
  z.object({ type: z.literal('ranked'), turns: z.number() }),
  z.object({ type: z.literal('checked'), checks: checksSchema }),
  z.object({ type: z.literal('error'), error: z.string().max(200).catch('analysis failed') }),
  analysisSchema.extend({ type: z.literal('done') }),
]);
type LiveEvent = z.infer<typeof eventSchema>;

function parseFrame(frame: string): LiveEvent | null {
  let type = '';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) type = line.slice('event: '.length);
    else if (line.startsWith('data: ')) data += line.slice('data: '.length);
  }
  try {
    const parsed = eventSchema.safeParse({ ...(JSON.parse(data) as object), type });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function stageOf({ read, asked, trace, turns, checks }: Pipeline): number {
  if (!read) return 0;
  if (asked.length === 0 || asked.some((a) => !trace.some((t) => t.tool === a.tool))) return 1;
  if (turns === null) return 2;
  return checks === null ? 3 : 4;
}

function apply(p: Pipeline, e: LiveEvent): Pipeline {
  const next = applyEvent(p, e);
  return { ...next, stage: Math.max(p.stage, stageOf(next)) };
}

function applyEvent(p: Pipeline, e: LiveEvent): Pipeline {
  if (e.type === 'read') return { ...p, model: e.model, read: { tokens: e.tokens, loan: e.loan } };
  if (e.type === 'asked')
    return {
      ...p,
      asked: [...p.asked, ...e.agents.filter((a) => !p.asked.some((b) => b.tool === a.tool))],
    };
  if (e.type === 'agent')
    return { ...p, trace: [...p.trace.filter((s) => s.tool !== e.step.tool), e.step] };
  if (e.type === 'ranked') return { ...p, turns: e.turns };
  if (e.type === 'checked') return { ...p, checks: e.checks };
  return p;
}

async function readStream(
  res: Response,
  onProgress: (p: Pipeline | null) => void,
): Promise<Analysis | { error: string } | null> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let live: Pipeline = {
    model: null,
    read: null,
    asked: [],
    trace: [],
    turns: null,
    checks: null,
    stage: 0,
    ranking: null,
  };
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      const frames = (buffer + value).split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const event = parseFrame(frame);
        if (!event) continue;
        if (event.type === 'error') return { error: event.error };
        if (event.type === 'done') {
          const { type: _, ...analysis } = event;
          return analysis;
        }
        live = apply(live, event);
        onProgress(live);
      }
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/**
 * Streams the run when it can; a stream that breaks falls back to the plain JSON reply, which the API answers from the
 * same run. An `error` frame is the run's answer, so it is shown, not retried.
 */
export async function runAnalysis(
  account: string,
  strategy: StrategyId,
  onProgress: (p: Pipeline | null) => void = () => {},
  signature?: string,
): Promise<{ ok: true; analysis: Analysis } | { ok: false; error: string }> {
  const post = (accept: string) =>
    fetch('/api/analysis', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept },
      body: JSON.stringify({ account, strategy, signature }),
    });
  let res: Response;
  try {
    res = await post('text/event-stream');
    if (res.ok && res.body && res.headers.get('content-type')?.startsWith('text/event-stream')) {
      const out = await readStream(res, onProgress);
      if (out && !('error' in out)) return { ok: true, analysis: out };
      onProgress(null);
      if (out) return { ok: false, error: out.error };
      res = await post('application/json');
    }
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
