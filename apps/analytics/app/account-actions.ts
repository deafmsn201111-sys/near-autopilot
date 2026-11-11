'use server';
import { forgetAccount } from '../lib/product';

export async function refreshAccount(account: unknown): Promise<void> {
  if (typeof account === 'string') forgetAccount(account.trim().toLowerCase());
}
