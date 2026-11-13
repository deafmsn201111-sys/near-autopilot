'use server';
import { cookies, headers } from 'next/headers';
import { accountIdSchema } from '@near-autopilot/core';
import { OWNERSHIP_COOKIE, OWNERSHIP_TTL_MS } from '@near-autopilot/core/ownership';
import { rememberStrategy, STRATEGY_COOKIE, strategySchema } from '@near-autopilot/core/strategy';
import { refreshAccountRead } from '../lib/product';

const accountOf = (account: unknown) =>
  accountIdSchema.safeParse(typeof account === 'string' ? account.trim().toLowerCase() : account);

export async function refreshAccount(account: unknown): Promise<boolean> {
  const id = accountOf(account);
  return id.success ? refreshAccountRead(id.data) : true;
}

const YEAR_S = 365 * 24 * 60 * 60;

// ponytail: per browser only; #100 moves it to a server-side setting the owner signs for.
/** Remembers the last strategy chosen for this account in this browser. */
export async function saveStrategy(account: unknown, strategy: unknown): Promise<void> {
  const id = accountOf(account);
  const choice = strategySchema.safeParse(strategy);
  if (!id.success || !choice.success) return;
  const secure = (await headers()).get('x-forwarded-proto') === 'https';
  const jar = await cookies();
  const value = rememberStrategy(jar.get(STRATEGY_COOKIE)?.value, id.data, choice.data);
  jar.set(STRATEGY_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: YEAR_S,
  });
}

/** Keeps the signed ownership proof in an HttpOnly cookie: page scripts can't read it, the API checks it. */
export async function saveOwnershipProof(proof: unknown): Promise<void> {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(proof)) return;
  const secure = (await headers()).get('x-forwarded-proto') === 'https';
  (await cookies()).set(OWNERSHIP_COOKIE, proof, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: OWNERSHIP_TTL_MS / 1000,
  });
}

export async function clearOwnershipProof(): Promise<void> {
  (await cookies()).delete(OWNERSHIP_COOKIE);
}
