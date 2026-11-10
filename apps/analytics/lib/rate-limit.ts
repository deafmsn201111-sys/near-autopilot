import 'server-only';
import { headers } from 'next/headers';

// ponytail: never evicts keys; bounding the map is #11
const hits = new Map<string, number[]>();

function take(key: string, limit: number, windowMs: number, now: number): boolean {
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
async function visitor(): Promise<string> {
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
  if (!take(`${kind}:${await visitor()}`, l.perVisitor, l.windowMs, now)) return false;
  return take(`${kind}:*`, l.overall, l.windowMs, now);
}
