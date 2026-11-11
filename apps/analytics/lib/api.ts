import 'server-only';
import { getEnv } from './env';

const UNREACHABLE = 'the analytics service is unreachable';

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Server-side only: the API token never reaches the browser. Every call is a read of stored data. A failure carries
 * the API's own short message (it never includes upstream text), never the internal address.
 */
export async function api<T>(path: string): Promise<T> {
  const env = getEnv();
  let res: Response;
  try {
    res = await fetch(`${env.API_BASE_URL}${path}`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${env.API_TOKEN}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    console.error(`analytics API ${path} unreachable`, e);
    throw new ApiRequestError(UNREACHABLE, 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    const message =
      typeof body.error === 'string'
        ? body.error
        : `the analytics service failed (HTTP ${res.status})`;
    throw new ApiRequestError(message, res.status);
  }
  return (await res.json()) as T;
}

export async function tryApi<T>(
  path: string,
): Promise<{ data: T | null; error: string | null; status: number | null }> {
  try {
    return { data: await api<T>(path), error: null, status: null };
  } catch (e) {
    if (e instanceof ApiRequestError) return { data: null, error: e.message, status: e.status };
    console.error(`analytics API ${path} failed`, e);
    return { data: null, error: 'the analytics service failed', status: null };
  }
}

/** Server-side POST to the analytics API (operator controls only). Returns the status and JSON body, never throws. */
export async function apiPost(
  path: string,
  body?: unknown,
  timeoutMs = 20_000,
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json };
  } catch (e) {
    console.error(`analytics API ${path} unreachable`, e);
    return { status: 0, body: { error: UNREACHABLE } };
  }
}
