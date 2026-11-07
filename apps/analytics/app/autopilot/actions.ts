'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';

/**
 * The dashboard's only state-changing calls: the three audited operator controls of the analytics API. None of them
 * can sign, send, approve or change a limit. Each needs a reason; the actor is recorded as the local dashboard.
 */
export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

const BY = 'dashboard operator (127.0.0.1)';
const errorOf = (r: { status: number; body: Record<string, unknown> }) =>
  typeof r.body['error'] === 'string' ? r.body['error'] : `HTTP ${r.status}`;

export async function runAnalysis(): Promise<ActionResult> {
  const r = await apiPost('/v1/control/collector/run');
  revalidatePath('/autopilot');
  if (r.status === 202)
    return {
      ok: true,
      message:
        'Market analysis started. It reads mainnet and re-analyses the demo portfolios; results appear in about a minute.',
    };
  if (r.status === 409)
    return { ok: false, message: 'An analysis is already running. Wait for it to finish.' };
  return { ok: false, message: `Could not start the analysis: ${errorOf(r)}` };
}

export async function setCollectorPaused(paused: boolean, reason: string): Promise<ActionResult> {
  const r = await apiPost(`/v1/control/collector/${paused ? 'pause' : 'resume'}`, {
    by: BY,
    reason,
  });
  revalidatePath('/autopilot');
  if (r.status !== 200) return { ok: false, message: errorOf(r) };
  return {
    ok: true,
    message:
      r.body['changed'] === false
        ? `Already ${paused ? 'paused' : 'running'}: nothing changed.`
        : paused
          ? 'Scheduled analysis paused. Manual runs still work.'
          : 'Scheduled analysis resumed.',
  };
}

export async function setMode(
  scope: string,
  mode: 'read_only' | 'normal',
  reason: string,
): Promise<ActionResult> {
  const r = await apiPost('/v1/control/mode', { scope, mode, by: BY, reason });
  revalidatePath('/autopilot');
  if (r.status !== 200) return { ok: false, message: errorOf(r) };
  return {
    ok: true,
    message:
      mode === 'read_only' ? 'Read-only mode engaged and recorded.' : 'Returned to normal mode.',
  };
}
