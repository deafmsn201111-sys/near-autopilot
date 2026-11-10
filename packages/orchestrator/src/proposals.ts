import { accountIdSchema } from '@near-autopilot/core';
import { z } from 'zod';

/**
 * The ONLY shape in which an agent (deterministic or LLM-backed) may express what it wants.
 *
 * A proposal is a declarative wish about portfolio state ("repay 100 USDT"), never a transaction. There is deliberately
 * no field for a receiver, method name, arguments, gas, deposit, nonce, signature or key: the schemas are `.strict()`,
 * so a response that carries any of them fails validation instead of being silently ignored. Turning a proposal into
 * a transaction is the job of protocol planners, and authorising it is the job of the policy engine; neither takes
 * input from an agent.
 *
 * Every agent output, including the output of the deterministic reference agents, passes through `parseAgentOutput`.
 * There is one trust boundary, not one per agent type.
 */

export const AGENT_IDS = [
  'market-intelligence',
  'lp-optimizer',
  'liquidation-guardian',
  'capital-allocator',
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const PROPOSAL_KINDS = [
  'no_action',
  'market.signal',
  'lp.reposition',
  'lending.repay',
  'lending.supply_collateral',
  'lending.supply',
  'allocation.swap',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Which proposal kinds each agent is allowed to emit. Anything else is a capability violation. */
export const AGENT_CAPABILITIES: Readonly<Record<AgentId, readonly ProposalKind[]>> = {
  'market-intelligence': ['no_action', 'market.signal'],
  'lp-optimizer': ['no_action', 'lp.reposition'],
  'liquidation-guardian': ['no_action', 'lending.repay', 'lending.supply_collateral'],
  'capital-allocator': ['no_action', 'allocation.swap', 'lending.supply'],
};

export const MAX_RATIONALE_LENGTH = 500;
export const MAX_PROPOSALS_PER_OUTPUT = 8;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Free text is data for humans reading the audit log. It is never parsed, executed or used as a decision input. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), { message: 'control characters are not allowed' });

/** Positive base-10 integer, no sign, no leading zeros, at most 39 digits (fits u128). Becomes a bigint. */
const amountString = z
  .string()
  .regex(/^[1-9]\d{0,38}$/, 'amount must be a positive decimal integer string')
  .transform((v) => BigInt(v));

const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));

const token = accountIdSchema;
// Rhea DCL ids look like `usdt.tether-token.near|wrap.near|2000` (pool) and `<pool>#<n>` (position), so `|` and `#`
// must be allowed; still no whitespace, quotes or control characters. 160 covers two 64-char account ids + suffix.
const identifier = z.string().regex(/^[A-Za-z0-9_.:|#-]{1,160}$/);

const base = { rationale: text(MAX_RATIONALE_LENGTH) };

export const NO_ACTION_REASONS = [
  'healthy',
  'no_edge',
  'insufficient_data',
  'within_threshold',
  'other',
] as const;
export const SIGNAL_TYPES = [
  'volatility_spike',
  'oracle_divergence',
  'depeg_risk',
  'liquidity_drop',
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

const noAction = z
  .object({ kind: z.literal('no_action'), reasonCode: z.enum(NO_ACTION_REASONS), ...base })
  .strict();
const marketSignal = z
  .object({
    kind: z.literal('market.signal'),
    token,
    signal: z.enum(SIGNAL_TYPES),
    severity: z.number().int().min(1).max(5),
    validUntil: isoDate,
    ...base,
  })
  .strict();
const lpReposition = z
  .object({
    kind: z.literal('lp.reposition'),
    positionId: identifier,
    tickLower: z.number().int(),
    tickUpper: z.number().int(),
    ...base,
  })
  .strict();
const repay = z
  .object({ kind: z.literal('lending.repay'), token, amount: amountString, ...base })
  .strict();
const supplyCollateral = z
  .object({ kind: z.literal('lending.supply_collateral'), token, amount: amountString, ...base })
  .strict();
/** Deposit idle wallet tokens into Burrow to earn the supply rate (NOT as collateral). Discretionary. */
const supply = z
  .object({ kind: z.literal('lending.supply'), token, amount: amountString, ...base })
  .strict();
const swap = z
  .object({
    kind: z.literal('allocation.swap'),
    tokenIn: token,
    tokenOut: token,
    amountIn: amountString,
    maxSlippageBps: z.number().int().min(0).max(1_000),
    ...base,
  })
  .strict();

const proposalSchema = z.discriminatedUnion('kind', [
  noAction,
  marketSignal,
  lpReposition,
  repay,
  supplyCollateral,
  supply,
  swap,
]);
export type Proposal = z.output<typeof proposalSchema>;
export type ProposalOf<K extends ProposalKind> = Extract<Proposal, { kind: K }>;

const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    agent: z.enum(AGENT_IDS),
    asOf: isoDate,
    proposals: z.array(z.unknown()).max(MAX_PROPOSALS_PER_OUTPUT),
  })
  .strict();

/**
 * Field names that no legitimate proposal contains. Strict schemas already reject them; this scan exists to tell an
 * agent that is merely wrong from one that is trying to smuggle something through (prompt injection, a compromised
 * model), because the orchestrator reacts to the second differently (quarantine, escalation).
 */
const FORBIDDEN_KEY = new RegExp(
  [
    'private[_-]?key',
    'secret',
    'seed',
    'mnemonic',
    'passphrase',
    'signature',
    'signed[_-]?tx',
    'signedtransaction',
    'receiver',
    'signer',
    'method[_-]?name',
    'calldata',
    'args',
    'actions',
    'nonce',
    'block[_-]?hash',
    'deposit',
    'gas',
    'allowlist',
    'policy',
    'override',
    'approve',
    'kill[_-]?switch',
    'limit',
    'access[_-]?key',
    'public[_-]?key',
  ].join('|'),
  'i',
);

export function findForbiddenKeys(
  value: unknown,
  path = '$',
  depth = 0,
  out: string[] = [],
): string[] {
  if (depth > 8 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findForbiddenKeys(v, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) out.push(`${path}.${key}`);
    findForbiddenKeys(v, `${path}.${key}`, depth + 1, out);
  }
  return out;
}

export interface ParsedProposal {
  readonly agent: AgentId;
  readonly proposal: Proposal;
  /** Stable identifier derived from content (set by the orchestrator, never by the agent). */
  readonly proposalId: string;
  readonly index: number;
}

export interface ParseIssue {
  readonly code:
    'MALFORMED_JSON' | 'SCHEMA' | 'WRONG_AGENT' | 'CAPABILITY' | 'FORBIDDEN_FIELD' | 'TOO_LARGE';
  readonly detail: string;
}

export interface AgentOutputParse {
  readonly agent: AgentId;
  readonly proposals: readonly Omit<ParsedProposal, 'proposalId'>[];
  readonly issues: readonly ParseIssue[];
  /** True when the output carried forbidden field names: treat the agent as possibly manipulated. */
  readonly suspicious: boolean;
  readonly asOf: Date | null;
}

const MAX_RAW_BYTES = 64 * 1024;

function summarize(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '$'}: ${i.message}`)
    .join('; ')
    .slice(0, 300);
}

/**
 * Validates raw agent output (already-parsed JSON, or a string that should contain JSON).
 * Invalid proposals are dropped individually: one bad proposal does not discard the valid ones, but it is reported
 * and counts toward the agent's quarantine threshold.
 */
export function parseAgentOutput(expectedAgent: AgentId, raw: unknown): AgentOutputParse {
  const issues: ParseIssue[] = [];
  const fail = (suspicious: boolean): AgentOutputParse => ({
    agent: expectedAgent,
    proposals: [],
    issues,
    suspicious,
    asOf: null,
  });

  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_RAW_BYTES) {
      issues.push({ code: 'TOO_LARGE', detail: `output is ${raw.length} characters` });
      return fail(false);
    }
    try {
      value = JSON.parse(raw);
    } catch {
      issues.push({ code: 'MALFORMED_JSON', detail: 'output is not valid JSON' });
      return fail(false);
    }
  } else {
    let size = 0;
    try {
      size = JSON.stringify(raw)?.length ?? 0;
    } catch {
      issues.push({ code: 'SCHEMA', detail: 'output is not JSON-serialisable' });
      return fail(false);
    }
    if (size > MAX_RAW_BYTES) {
      issues.push({ code: 'TOO_LARGE', detail: `output is ${size} characters` });
      return fail(false);
    }
  }

  const forbidden = findForbiddenKeys(value);
  const suspicious = forbidden.length > 0;
  if (suspicious)
    issues.push({
      code: 'FORBIDDEN_FIELD',
      detail: `forbidden field names: ${forbidden.slice(0, 5).join(', ')}`,
    });

  const envelope = envelopeSchema.safeParse(value);
  if (!envelope.success) {
    issues.push({ code: 'SCHEMA', detail: summarize(envelope.error) });
    return fail(suspicious);
  }
  if (envelope.data.agent !== expectedAgent) {
    issues.push({
      code: 'WRONG_AGENT',
      detail: `output claims to be ${envelope.data.agent}, expected ${expectedAgent}`,
    });
    return fail(true); // an agent speaking as another agent is never an innocent mistake
  }

  const proposals: Omit<ParsedProposal, 'proposalId'>[] = [];
  envelope.data.proposals.forEach((rawProposal, index) => {
    const parsed = proposalSchema.safeParse(rawProposal);
    if (!parsed.success) {
      issues.push({ code: 'SCHEMA', detail: `proposal[${index}]: ${summarize(parsed.error)}` });
      return;
    }
    if (!AGENT_CAPABILITIES[expectedAgent].includes(parsed.data.kind)) {
      issues.push({
        code: 'CAPABILITY',
        detail: `proposal[${index}]: ${expectedAgent} may not emit ${parsed.data.kind}`,
      });
      return;
    }
    proposals.push({ agent: expectedAgent, proposal: parsed.data, index });
  });
  return { agent: expectedAgent, proposals, issues, suspicious, asOf: envelope.data.asOf };
}
