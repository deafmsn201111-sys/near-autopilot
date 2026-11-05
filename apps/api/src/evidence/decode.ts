import { accountIdSchema } from '@near-autopilot/core';
import {
  policyConfigSchema,
  type PolicyConfig,
  type PolicyInput,
} from '@near-autopilot/policy-engine';
import { z } from 'zod';

/**
 * Decodes a stored verdict input (JSON-safe: bigint as decimal text, Date as ISO, Map as object) back into the exact
 * typed `PolicyInput` the policy engine evaluated. Strict: an unknown or missing field fails the decode rather than
 * being guessed. That the decode is faithful is checked independently by recomputing the snapshot id and plan hash.
 */
const int = z
  .string()
  .regex(/^-?\d+$/)
  .transform(BigInt);
const date = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));
const account = accountIdSchema;
const balance = z.object({ token: account, raw: int }).strict();
const price = z.object({ multiplier: int, decimals: z.number().int() }).strict();
const risk = z
  .object({
    token: account,
    collateralFactorBps: z.number().int(),
    borrowFactorBps: z.number().int(),
    canBeCollateral: z.boolean(),
    canBorrow: z.boolean(),
  })
  .strict();
const tokenInfo = z
  .object({ id: account, symbol: z.string(), decimals: z.number().int() })
  .strict();
const asMap = <V extends z.ZodTypeAny>(v: V) =>
  z
    .record(v)
    .transform((o) => new Map(Object.entries(o).map(([k, x]) => [accountIdSchema.parse(k), x])));

const snapshot = z
  .object({
    accountId: account,
    takenAt: date,
    pricesAsOf: date,
    nativeBalance: int,
    walletBalances: z.array(balance),
    lending: z
      .object({
        protocol: z.enum(['rhea', 'burrow']),
        accountId: account,
        supplied: z.array(balance),
        collateral: z.array(balance),
        borrowed: z.array(balance),
      })
      .strict()
      .nullable(),
    prices: asMap(price),
    risk: asMap(risk),
    tokens: asMap(tokenInfo),
  })
  .strict();

const base = { id: z.string(), agentId: z.string(), reason: z.string() };
const intent = z.discriminatedUnion('kind', [
  z
    .object({
      ...base,
      kind: z.literal('swap'),
      protocol: z.literal('rhea'),
      tokenIn: account,
      tokenOut: account,
      amountIn: int,
      poolId: z.number().int(),
      quotedAmountOut: int,
      minAmountOut: int,
      slippageBps: z.number().int(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('lending.repay'),
      protocol: z.literal('burrow'),
      token: account,
      amount: int,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal('lending.supply'),
      protocol: z.literal('burrow'),
      token: account,
      amount: int,
      asCollateral: z.boolean(),
    })
    .strict(),
]);

const plan = z
  .object({
    intentId: z.string(),
    signerId: account,
    receiverId: account,
    actions: z.array(
      z
        .object({
          type: z.literal('FunctionCall'),
          methodName: z.string(),
          args: z.record(z.unknown()),
          gas: int,
          deposit: int,
        })
        .strict(),
    ),
  })
  .strict();

const history = z.object({ spentLast24hUsdMicro: int, lastExecutedAt: date.nullable() }).strict();

const stored = z
  .object({
    intent,
    plan,
    snapshot,
    history,
    /** Absent on verdicts stored before the config was recorded with them. */
    config: z.unknown().optional(),
  })
  .strict();

export interface DecodedVerdictInput {
  readonly input: PolicyInput;
  /** null when the row predates config recording. */
  readonly config: PolicyConfig | null;
}

export function decodeVerdictInput(raw: unknown): DecodedVerdictInput {
  const s = stored.parse(raw);
  return {
    input: {
      intent: s.intent,
      plan: s.plan,
      snapshot: s.snapshot,
      history: s.history,
    },
    config: s.config === undefined ? null : policyConfigSchema.parse(s.config),
  };
}
