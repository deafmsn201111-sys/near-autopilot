import { accountIdSchema } from '@near-autopilot/core';
import type { TxCall, TxOutcome } from '@near-autopilot/near-adapter';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventStore } from '../analytics/events';
import { describeOutcome, type OutcomeContext } from './outcome';

/**
 * The single verifier of a signed step (#32): NEAR RPC, not the browser, says whether it happened. A `signed` row is
 * written only when the transaction is final and successful, its signer is the account, and it is exactly the step of
 * the cascade this server prepared: same receiver and, action by action, the same method, args and deposit (a wallet may adjust gas). An
 * older transaction of the account with the same contract and method therefore does not pass (its amounts differ).
 */
export interface ConfirmDeps {
  readonly events: EventStore;
  readonly txs: { status(hash: string, signerId: string): Promise<TxOutcome | null> };
  readonly burrowId: string;
  readonly tokens: () => Promise<OutcomeContext['tokens']>;
  readonly now: () => Date;
}

const NOT_OURS = 'this transaction is not a step of the prepared cascade';
const UNKNOWN = 'unknown cascade';

const stepSchema = z.object({
  intentId: z.string(),
  receiverId: z.string(),
  calls: z.array(
    z.object({ method: z.string(), args: z.unknown(), gas: z.string(), deposit: z.string() }),
  ),
});
type Step = z.infer<typeof stepSchema>;

const stepsOf = (detail: Record<string, unknown> | undefined): Step[] =>
  z.array(stepSchema).catch([]).parse(detail?.['steps']);

/** JSON with object keys sorted, so the same args compare equal whatever order the wallet serialised them in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const sameCalls = (signed: readonly TxCall[], expected: Step['calls']) =>
  signed.length === expected.length &&
  signed.every((c, i) => {
    const e = expected[i];
    return (
      e !== undefined &&
      c.method === e.method &&
      c.deposit === e.deposit &&
      canonical(c.args) === canonical(e.args)
    );
  });

export function registerConfirm(app: FastifyInstance, deps: ConfirmDeps) {
  app.post('/v1/wallet/confirm', async (req, reply) => {
    const body = z
      .object({
        account: accountIdSchema,
        cascadeId: z.string().uuid(),
        step: z.number().int().min(0).max(31),
        hash: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid confirm request' });
    const { account, cascadeId, step, hash } = body.data;

    const rows = await deps.events.byCascade(cascadeId);
    const prepared = rows.find((r) => r.kind === 'prepare' && r.accountId === account);
    const expected = stepsOf(prepared?.detail)[step];
    if (!prepared || !expected) return reply.code(404).send({ error: UNKNOWN });
    const preview = Array.isArray(prepared.detail?.['preview']) ? prepared.detail['preview'] : [];
    const fallback = typeof preview[step] === 'string' ? [preview[step]] : [];

    const known = rows.find((r) => r.kind === 'signed' && r.txHash === hash);
    if (known) return { status: 'confirmed', lines: known.detail?.['lines'] ?? fallback };

    let out: TxOutcome | null;
    try {
      out = await deps.txs.status(hash, account);
    } catch (err) {
      req.log.warn({ err }, 'tx status read failed');
      return reply.code(502).send({ error: 'could not check the transaction right now' });
    }
    if (!out) return reply.code(202).send({ status: 'pending' });
    const sameStep =
      out.signerId === account &&
      out.receiverId === expected.receiverId &&
      sameCalls(out.calls, expected.calls);
    if (!sameStep) return reply.code(422).send({ error: NOT_OURS });

    const summary = describeOutcome(out, {
      account,
      burrowId: deps.burrowId,
      tokens: await deps.tokens(),
    });
    if (!summary.ok) return { status: 'failed', ...summary };
    const lines = summary.lines.length ? summary.lines : fallback;
    const stored = await deps.events.add({
      at: deps.now(),
      kind: 'signed',
      accountId: account,
      source: 'rpc',
      cascadeId,
      txHash: hash,
      detail: { step: expected.intentId, receiverId: expected.receiverId, lines },
    });
    // The hash is already stored under another cascade: one transaction is one step of one cascade.
    if (!stored) return reply.code(409).send({ error: NOT_OURS });
    return { status: 'confirmed', lines };
  });
}
