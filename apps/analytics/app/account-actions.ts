'use server';
import { cookies, headers } from 'next/headers';
import { accountIdSchema } from '@near-autopilot/core';
import { OWNERSHIP_COOKIE, OWNERSHIP_TTL_MS } from '@near-autopilot/core/ownership';
import { refreshAccountRead } from '../lib/product';

/** True once the fresh read shows a changed account (or there is nothing more to wait for). */
export async function refreshAccount(account: unknown): Promise<boolean> {
  const id = accountIdSchema.safeParse(
    typeof account === 'string' ? account.trim().toLowerCase() : account,
  );
  return id.success ? refreshAccountRead(id.data) : true;
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
