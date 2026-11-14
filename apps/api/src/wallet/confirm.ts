import { accountIdSchema } from '@near-autopilot/core';
import type { TxOutcome } from '@near-autopilot/near-adapter';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventStore, PreparedStep } from '../analytics/events';
import { describeOutcome, type OutcomeContext } from './outcome';

/**
 * The single verifier of a signed step (#32): NEAR RPC, not the browser, says whether it happened. A `signed` row is
 * written only when the transaction is final and successful, its signer is the account, and it is exactly the step of
 * the cascade this server prepared (same receiver, same methods). Anything else writes nothing.
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

const stepsOf = (detail: Record<string, unknown> | undefined): PreparedStep[] =>
  z
    .array(z.object({ intentId: z.string(), receiverId: z.string(), methods: z.array(z.string()) }))
    .catch([])
    .parse(detail?.['steps']);

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
      out.methods.length === expected.methods.length &&
      out.methods.every((m, i) => m === expected.methods[i]);
    if (!sameStep) return reply.code(422).send({ error: NOT_OURS });

    const summary = describeOutcome(out, {
      account,
      burrowId: deps.burrowId,
      tokens: await deps.tokens(),
    });
    if (!summary.ok) return { status: 'failed', ...summary };
    const lines = summary.lines.length ? summary.lines : fallback;
    await deps.events.add({
      at: deps.now(),
      kind: 'signed',
      accountId: account,
      source: 'rpc',
      cascadeId,
      txHash: hash,
      detail: { step: expected.intentId, receiverId: expected.receiverId, lines },
    });
    return { status: 'confirmed', lines };
  });
}
