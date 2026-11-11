import 'server-only';
import { BoundedMap } from '@near-autopilot/core';
import { headers } from 'next/headers';

// Expired visitors are swept first; only a flood of live visitors past the cap drops the least recent one (its count
// resets). The overall counts, one per kind, live apart so no flood can evict them.
export const MAX_TRACKED_KEYS = 10_000;
const visitors = new BoundedMap<string, number[]>(MAX_TRACKED_KEYS);
const overall = new Map<string, number[]>();
export const trackedKeys = () => visitors.size;

function sweep(now: number, windowMs: number) {
  if (visitors.size < MAX_TRACKED_KEYS) return;
  for (const [key, times] of visitors)
    if (times.every((t) => now - t >= windowMs)) visitors.delete(key);
}

function take(
  hits: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

// Trusted only because Caddy overwrites X-Forwarded-For (deploy/public/Caddyfile).
export async function visitor(): Promise<string> {
  const h = await headers();
  return (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
}

export interface Limit {
  perVisitor: number;
  overall: number;
  windowMs: number;
}

// Per visitor first, so one visitor over the limit does not use up the overall allowance.
export async function consume(kind: string, l: Limit, now = Date.now()): Promise<boolean> {
  sweep(now, l.windowMs);
  if (!take(visitors, `${kind}:${await visitor()}`, l.perVisitor, l.windowMs, now)) return false;
  return take(overall, kind, l.overall, l.windowMs, now);
}

// "Your account" reads a mainnet account through our RPC key: limited for every visitor of the public site.
export const ACCOUNT_LIMIT: Limit = { perVisitor: 30, overall: 600, windowMs: 10 * 60_000 };
export const RATE_LIMITED = 'Too many requests right now. Wait a few minutes and try again.';
