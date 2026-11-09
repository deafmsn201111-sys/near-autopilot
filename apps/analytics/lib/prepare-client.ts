'use client';
import type { PrepareError, PrepareRequest, PrepareResult, PreparedCascade } from './prepare-types';

/**
 * Ask the server to assemble an unsigned, signable cascade for an intent (via the /api/prepare proxy). Read-only:
 * it never signs. Returns a typed result so the UI can show either the exact cascade or a clear reason it refused.
 */
export async function prepareIntent(req: PrepareRequest): Promise<PrepareResult> {
  let res: Response;
  try {
    res = await fetch('/api/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error' };
  }
  const json = (await res.json().catch(() => ({}))) as Partial<PreparedCascade> &
    Partial<PrepareError>;
  if (!res.ok || json.signed !== false || !Array.isArray(json.transactions)) {
    return {
      ok: false,
      status: res.status,
      error: typeof json.error === 'string' ? json.error : `prepare failed (HTTP ${res.status})`,
      ...(Array.isArray(json.reasons) ? { reasons: json.reasons } : {}),
    };
  }
  return { ok: true, cascade: json as PreparedCascade };
}
