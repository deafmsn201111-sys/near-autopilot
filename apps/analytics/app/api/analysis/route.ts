import { accountIdSchema } from '@near-autopilot/core';
import { OWNERSHIP_COOKIE } from '@near-autopilot/core/ownership';
import { strategySchema } from '@near-autopilot/core/strategy';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiPost, apiPostStream } from '../../../lib/api';
import { ACCOUNT_LIMIT, consume } from '../../../lib/rate-limit';

/**
 * Server proxy for `POST /v1/analytics/account/:id/analysis`: the API re-ranks the account's recommendations (with the
 * LLM when available, heuristics otherwise). Forwards with the server-side API token and returns the result verbatim.
 */
export const dynamic = 'force-dynamic';

// The global AI limit lives in the API and counts only model runs. The overall count here only guards the RPC reads,
// like an account read, far above the AI limit so rule-based answers cannot block an owner's AI.
const LIMIT = { ...ACCOUNT_LIMIT, perVisitor: 5 };
const LLM_TIMEOUT_MS = 60_000;

function isJson(req: Request): boolean {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

export async function POST(req: Request): Promise<Response> {
  if (!isJson(req)) {
    return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const fields = (body ?? {}) as { account?: unknown; strategy?: unknown };
  const raw = fields.account;
  const account = accountIdSchema.safeParse(
    typeof raw === 'string' ? raw.trim().toLowerCase() : raw,
  );
  const strategy = strategySchema.safeParse(fields.strategy);
  if (!account.success || !strategy.success) {
    return NextResponse.json(
      { error: 'body must be { account: <NEAR account id>, strategy?: <strategy name> }' },
      { status: 400 },
    );
  }
  if (!(await consume('analysis', LIMIT))) {
    return NextResponse.json(
      { error: 'Too many requests. Wait a few minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(LIMIT.windowMs / 1000) } },
    );
  }
  // The API calls the model only for the account's proven owner (D12); everyone else gets the rule-based list.
  const proof = (await cookies()).get(OWNERSHIP_COOKIE)?.value;
  const path = `/v1/analytics/account/${encodeURIComponent(account.data)}/analysis`;
  const forward: Record<string, string> = proof ? { 'x-ownership-proof': proof } : {};
  if (req.headers.get('accept')?.includes('text/event-stream')) {
    // The browser leaving cancels the upstream request, so the API stops the model run.
    return stream(
      await apiPostStream(path, { strategy: strategy.data }, LLM_TIMEOUT_MS, forward, req.signal),
    );
  }
  const { status, body: out } = await apiPost(
    path,
    { strategy: strategy.data },
    LLM_TIMEOUT_MS,
    forward,
  );
  return NextResponse.json(out, { status: status || 502 });
}

/** The live pipeline (#113): the API's events pass through as they come; `no-transform` keeps compression off it. */
async function stream(res: Response | null): Promise<Response> {
  if (!res)
    return NextResponse.json({ error: 'the analytics service is unreachable' }, { status: 502 });
  if (res.ok && res.body && res.headers.get('content-type')?.startsWith('text/event-stream')) {
    return new Response(res.body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  }
  const out: unknown = await res.json().catch(() => ({}));
  return NextResponse.json(out, { status: res.status || 502 });
}
