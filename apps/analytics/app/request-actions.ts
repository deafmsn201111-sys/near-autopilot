'use server';
import { revalidatePath } from 'next/cache';
import { getEnv } from '../lib/env';

/**
 * "Let the agent do it" from a demo portfolio: the request is sent to the shadow autopilot API, which runs it through
 * the planner, the policy engine (12 checks) and the dry-run executor. Server-side only: the token never reaches the
 * browser. Only Burrow deposits and repayments are requestable; nothing here can sign or send a transaction.
 */
export interface RequestOutcome {
  readonly id: string | null;
  readonly status: 'done' | 'blocked' | 'needs_approval' | 'failed';
  readonly sentence: string;
  readonly reasons: readonly string[];
  readonly expiresAt: string | null;
}

const ACTIONS: Record<string, { kind: 'supply' | 'repay'; token: string }> = {
  repay: { kind: 'repay', token: 'usdt.tether-token.near' },
  'lend-usdt': { kind: 'supply', token: 'usdt.tether-token.near' },
  'lend-near': { kind: 'supply', token: 'wrap.near' },
};
const BY = 'dashboard user (demo)';

async function post(path: string, body: unknown): Promise<RequestOutcome> {
  const base = process.env['AUTOPILOT_API_URL'];
  if (!base)
    return {
      id: null,
      status: 'failed',
      sentence: 'The autopilot API is not configured for requests.',
      reasons: [],
      expiresAt: null,
    };
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${getEnv().API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<RequestOutcome> & {
      error?: string;
    };
    if (!res.ok)
      return {
        id: null,
        status: 'failed',
        sentence: json.error ?? `HTTP ${res.status}`,
        reasons: [],
        expiresAt: null,
      };
    return {
      id: json.id ?? null,
      status: json.status ?? 'failed',
      sentence: json.sentence ?? '',
      reasons: json.reasons ?? [],
      expiresAt: json.expiresAt ?? null,
    };
  } catch (e) {
    return {
      id: null,
      status: 'failed',
      sentence: `The autopilot did not answer: ${e instanceof Error ? e.message : String(e)}`,
      reasons: [],
      expiresAt: null,
    };
  } finally {
    revalidatePath('/activity');
  }
}

export async function requestAgentAction(
  portfolio: string,
  actionId: string,
  usd: number,
): Promise<RequestOutcome> {
  const a = ACTIONS[actionId];
  if (!a)
    return {
      id: null,
      status: 'failed',
      sentence: 'The agent cannot do this action yet.',
      reasons: [],
      expiresAt: null,
    };
  return post('/v1/requests', { portfolio, kind: a.kind, token: a.token, usd, by: BY });
}

export async function confirmAgentAction(portfolio: string, id: string): Promise<RequestOutcome> {
  return post(`/v1/requests/${encodeURIComponent(id)}/confirm`, { portfolio, by: BY });
}
