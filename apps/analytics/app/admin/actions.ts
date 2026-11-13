'use server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { adminApi } from '../../lib/admin';

export interface ActionState {
  error: string | null;
}

const usdField = (max: number) => z.coerce.number().positive().max(max);

async function save(body: Record<string, unknown>): Promise<ActionState> {
  try {
    await adminApi('/settings', body);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'save failed' };
  }
  revalidatePath('/admin');
  return { error: null };
}

export async function setLlmEnabled(_: ActionState, form: FormData): Promise<ActionState> {
  return save({ llmEnabled: form.get('llmEnabled') === 'on' });
}

export async function setDailyCap(_: ActionState, form: FormData): Promise<ActionState> {
  const cap = usdField(1000).safeParse(form.get('dailyCapUsd'));
  return cap.success
    ? save({ dailyCapUsd: cap.data })
    : { error: 'cap: a number from 0.01 to 1000' };
}

export async function setDeposit(_: ActionState, form: FormData): Promise<ActionState> {
  const deposit = usdField(1_000_000).safeParse(form.get('depositUsd'));
  return deposit.success
    ? save({ depositUsd: deposit.data })
    : { error: 'deposit: a number from 0.01 to 1,000,000' };
}
