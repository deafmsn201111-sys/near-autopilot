import 'server-only';
import { getEnv } from './env';

/** Server-side only: the API token never reaches the browser. Every call is a read of stored data. */
export async function api<T>(path: string): Promise<T> {
  const env = getEnv();
  const res = await fetch(`${env.API_BASE_URL}${path}`, {
    cache: 'no-store',
    headers: { authorization: `Bearer ${env.API_TOKEN}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`analytics API ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function tryApi<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await api<T>(path), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Server-side POST to the analytics API (operator controls only). Returns the status and JSON body, never throws. */
export async function apiPost(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = getEnv();
  try {
    const res = await fetch(`${env.API_BASE_URL}${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${env.API_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json };
  } catch (e) {
    return { status: 0, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}
