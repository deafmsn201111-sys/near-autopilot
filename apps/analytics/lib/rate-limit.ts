import 'server-only';
import { headers } from 'next/headers';

/** Sliding-window hit log per key. In memory: it resets on a restart and never weakens a policy limit. */
const hits = new Map<string, number[]>();

export function take(key: string, limit: number, windowMs: number, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/** The visitor's address as the reverse proxy reports it (first X-Forwarded-For entry), else a fixed key. */
export async function visitor(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
}

export interface Limit {
  perVisitor: number;
  overall: number;
  windowMs: number;
}

/**
 * Whether this call is within the limits (and counts it). Counted per visitor first, so one visitor over the limit
 * does not use up the overall allowance.
 */
export async function withinLimit(kind: string, l: Limit, now = Date.now()): Promise<boolean> {
  if (!take(`${kind}:${await visitor()}`, l.perVisitor, l.windowMs, now)) return false;
  return take(`${kind}:*`, l.overall, l.windowMs, now);
}
