import 'server-only';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LOOPBACK_HOST } from './admin-host';
import { getEnv } from './env';

/** The admin exists only in the loopback admin container (ADMIN_UI=1); everywhere else /admin is a 404. */
export const adminEnabled = () => process.env.ADMIN_UI === '1';

export interface Spend {
  llmEnabled: boolean;
  todayUsd: number;
  capUsd: number;
  capIsDefault: boolean;
  days: { day: string; usd: number }[];
  models: { model: string; analyses: number; usd: number }[];
  analyses: number;
  avgPerAnalysisUsd: number | null;
  dailyAvgUsd: number;
  deposit: {
    balanceUsd: number;
    enteredAt: string;
    enteredDaysAgo: number;
    spentSinceUsd: number;
    leftUsd: number;
    runOutDate: string | null;
  } | null;
}

/** Calls /v1/admin/* with ADMIN_API_TOKEN; 404 outside the admin container. */
export async function adminApi<T>(path: string, body?: unknown): Promise<T> {
  const token = getEnv().ADMIN_API_TOKEN;
  if (!adminEnabled() || !token) notFound();
  // Checked here as well as in the middleware: a server action can be posted to a path the middleware skips.
  if (!LOOPBACK_HOST.test((await headers()).get('host') ?? '')) notFound();
  const res = await fetch(`${getEnv().API_BASE_URL}/v1/admin${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok)
    throw new Error(typeof json.error === 'string' ? json.error : `admin API HTTP ${res.status}`);
  return json as T;
}
