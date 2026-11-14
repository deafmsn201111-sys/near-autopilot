'use client';

/** Reports a wallet connect. Best effort and fire-and-forget: it must survive the page navigating away. */
export function reportConnect(account: string): void {
  void fetch('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'connect', account }),
    keepalive: true,
  }).catch(() => undefined);
}

export type StepResult =
  | { readonly status: 'confirmed'; readonly lines: readonly string[] }
  | {
      readonly status: 'failed';
      readonly lines: readonly string[];
      readonly failure: { readonly contract: string; readonly error: string };
      readonly funds: string;
    }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'unchecked' };

export interface ConfirmRequest {
  readonly account: string;
  readonly cascadeId: string;
  readonly step: number;
  readonly hash: string;
}

const NOT_CONFIRMED =
  'The network has not confirmed this step yet. Check it on the explorer before signing anything else.';

/**
 * Asks the server (which asks NEAR RPC) for a step's final status, a few times while the network is still finalising
 * it. Only the server's answer counts: the browser cannot mark a step as done.
 */
export async function confirmStep(
  req: ConfirmRequest,
  opts: {
    attempts?: number;
    delayMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<StepResult> {
  const attempts = opts.attempts ?? 10;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let reason = NOT_CONFIRMED;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.delayMs ?? 2_000);
    let res: Response;
    try {
      res = await fetchImpl('/api/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
    } catch {
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 200 && (body['status'] === 'confirmed' || body['status'] === 'failed'))
      return body as unknown as StepResult;
    if (res.status === 202 || res.status === 502) continue;
    // The server has no record of this cascade (not stored, or events off): the step was sent but cannot be checked.
    if (res.status === 404) return { status: 'unchecked' };
    if (typeof body['error'] === 'string')
      reason = `Could not confirm this step: ${body['error']}.`;
    return { status: 'unknown', reason };
  }
  return { status: 'unknown', reason };
}
