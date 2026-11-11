'use server';
import { accountIdSchema } from '@near-autopilot/core';
import { forgetAccount } from '../lib/product';

export async function refreshAccount(account: unknown): Promise<void> {
  const id = accountIdSchema.safeParse(
    typeof account === 'string' ? account.trim().toLowerCase() : account,
  );
  if (id.success) await forgetAccount(id.data);
}
