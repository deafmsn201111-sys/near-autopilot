import 'server-only';
import { BoundedMap } from '@near-autopilot/core';
import { headers } from 'next/headers';
import { processWide } from './process-state';

// One map per kind, so each holds one window and its least recently hit visitor is also its most expired one. Past the
// cap that visitor is dropped: a flood of live visitors resets the least recent one's count, while the overall cap still
// holds. The overall counts, one per kind, live apart so no flood can evict them.
export const MAX_TRACKED_KEYS = 10_000;
const visitors = processWide(
  'rateLimitVisitors',
  () => new Map<string, BoundedMap<string, number[]>>(),
);
const overall = processWide('rateLimitOverall', () => new Map<string, number[]>());
export const trackedKeys = () => [...visitors.values()].reduce((n, m) => n + m.size, 0);

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

// One home or VPS gets a whole IPv6 /64, so its 2^64 addresses share one key. IPv4-mapped addresses key as IPv4;
// anything that is not a well-formed IPv6 address keys as given.
function subnet(address: string): string {
  if (!address.includes(':')) return address;
  const v4 = /\d{1,3}(?:\.\d{1,3}){3}$/.exec(address)?.[0];
  const halves = (v4 ? `${address.slice(0, -v4.length)}0:0` : address).split('::');
  if (halves.length > 2) return address;
  const [left = [], right = []] = halves.map((h) => (h ? h.split(':') : []));
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return address;
  const full = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (!full.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return address;
  const n = full.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff)
    return v4 ?? [n[6]! >> 8, n[6]! & 255, n[7]! >> 8, n[7]! & 255].join('.');
  return `${n
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

// Trusted only because Caddy overwrites X-Forwarded-For (deploy/public/Caddyfile).
export async function visitor(): Promise<string> {
  const h = await headers();
  return subnet(
    (h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim()) ?? 'unknown',
  );
}

export interface Limit {
  perVisitor: number;
  overall: number;
  windowMs: number;
}

// Per visitor first, so one visitor over the limit does not use up the overall allowance.
export async function consume(kind: string, l: Limit, now = Date.now()): Promise<boolean> {
  let ofKind = visitors.get(kind);
  if (!ofKind) visitors.set(kind, (ofKind = new BoundedMap(MAX_TRACKED_KEYS)));
  if (!take(ofKind, await visitor(), l.perVisitor, l.windowMs, now)) return false;
  return take(overall, kind, l.overall, l.windowMs, now);
}

// "Your account" reads a mainnet account through our RPC key: limited for every visitor of the public site.
export const ACCOUNT_LIMIT: Limit = { perVisitor: 30, overall: 600, windowMs: 10 * 60_000 };
export const RATE_LIMITED = 'Too many requests right now. Wait a few minutes and try again.';
