import {
  MissingPriceError,
  USD_SCALE,
  intentTokens,
  type ActionIntent,
  type PlannedTransaction,
  type PolicyViolation,
  type PortfolioSnapshot,
} from '@near-autopilot/core';
import { oracleDeviationBps, priceOf, tokenValueUsd } from '@near-autopilot/financial-engine';
import type { PolicyConfig } from './config';

export interface PolicyHistory {
  /** Value of live, successful executions in the trailing 24h (micro-USD). */
  readonly spentLast24hUsdMicro: bigint;
  readonly lastExecutedAt: Date | null;
}

export interface PolicyInput {
  readonly intent: ActionIntent;
  readonly plan: PlannedTransaction;
  readonly snapshot: PortfolioSnapshot;
  readonly history: PolicyHistory;
}

export interface RuleContext extends PolicyInput {
  readonly config: PolicyConfig;
  readonly now: Date;
  /** Valuation computed here from oracle prices; null if a price is missing. */
  readonly valueUsdMicro: bigint | null;
  readonly limits: {
    readonly maxActionUsdMicro: bigint;
    readonly dailyLimitUsdMicro: bigint;
    readonly approvalThresholdUsdMicro: bigint;
  };
}

export type Rule = (ctx: RuleContext) => PolicyViolation[];

const reject = (rule: string, message: string): PolicyViolation => ({
  rule,
  message,
  severity: 'reject',
});
const approval = (rule: string, message: string): PolicyViolation => ({
  rule,
  message,
  severity: 'approval',
});

export function valueIntentUsd(intent: ActionIntent, snapshot: PortfolioSnapshot): bigint | null {
  try {
    if (intent.kind === 'swap')
      return tokenValueUsd(snapshot.prices, intent.tokenIn, intent.amountIn);
    return tokenValueUsd(snapshot.prices, intent.token, intent.amount);
  } catch (error) {
    if (error instanceof MissingPriceError) return null;
    throw error;
  }
}

const usd = (micro: bigint): string => `$${(Number(micro) / Number(USD_SCALE)).toFixed(2)}`;

export const killSwitch: Rule = ({ config }) =>
  config.enabled ? [] : [reject('kill_switch', 'Autopilot is disabled by policy')];

export const signerRule: Rule = ({ plan, config }) =>
  plan.signerId === config.signerAccountId
    ? []
    : [reject('signer', `Signer ${plan.signerId} is not the configured autopilot account`)];

export const dataFreshness: Rule = ({ snapshot, config, now }) => {
  const maxMs = config.maxPriceAgeSeconds * 1000;
  const out: PolicyViolation[] = [];
  if (now.getTime() - snapshot.pricesAsOf.getTime() > maxMs) {
    out.push(
      reject('price_freshness', `Oracle prices are older than ${config.maxPriceAgeSeconds}s`),
    );
  }
  if (now.getTime() - snapshot.takenAt.getTime() > maxMs) {
    out.push(
      reject(
        'snapshot_freshness',
        `Portfolio snapshot is older than ${config.maxPriceAgeSeconds}s`,
      ),
    );
  }
  return out;
};

export const nativeReserve: Rule = ({ snapshot, config }) =>
  snapshot.nativeBalance >= config.minNativeReserveYocto
    ? []
    : [reject('native_reserve', 'Native NEAR balance is below the gas reserve')];

export const contractAllowlist: Rule = ({ plan, config }) =>
  config.allowedContracts.includes(plan.receiverId)
    ? []
    : [reject('contract_allowlist', `Receiver ${plan.receiverId} is not allowlisted`)];

export const tokenAllowlist: Rule = ({ intent, config }) =>
  intentTokens(intent)
    .filter((t) => !config.allowedTokens.includes(t))
    .map((t) => reject('token_allowlist', `Token ${t} is not allowlisted`));

export const actionShape: Rule = ({ plan, config }) => {
  const out: PolicyViolation[] = [];
  if (plan.actions.length !== 1) {
    out.push(reject('action_shape', `Expected exactly 1 action, got ${plan.actions.length}`));
  }
  for (const action of plan.actions) {
    if (action.type !== 'FunctionCall') {
      out.push(reject('action_shape', `Action type ${String(action.type)} is not permitted`));
      continue;
    }
    if (!config.allowedMethods.includes(action.methodName)) {
      out.push(reject('method_allowlist', `Method ${action.methodName} is not allowlisted`));
    }
    if (action.deposit > config.maxDepositYocto) {
      out.push(
        reject(
          'deposit_cap',
          `Attached deposit ${action.deposit} exceeds ${config.maxDepositYocto} yoctoNEAR`,
        ),
      );
    }
    if (action.methodName === 'ft_transfer_call') {
      const recipient = action.args['receiver_id'];
      if (typeof recipient !== 'string' || !config.allowedRecipients.some((r) => r === recipient)) {
        out.push(
          reject(
            'recipient_allowlist',
            `ft_transfer_call recipient ${String(recipient)} is not allowlisted`,
          ),
        );
      }
    }
  }
  return out;
};

/** The plan must say exactly what the intent said; guards against planner bugs and tampering. */
export const intentMatchesPlan: Rule = ({ intent, plan }) => {
  const out: PolicyViolation[] = [];
  const action = plan.actions[0];
  if (plan.intentId !== intent.id)
    out.push(reject('intent_match', 'Plan does not belong to this intent'));
  if (!action) return out;

  const spendToken = intent.kind === 'swap' ? intent.tokenIn : intent.token;
  const spendAmount = intent.kind === 'swap' ? intent.amountIn : intent.amount;
  if (plan.receiverId !== spendToken)
    out.push(
      reject('intent_match', `Plan targets ${plan.receiverId}, intent spends ${spendToken}`),
    );
  if (action.args['amount'] !== spendAmount.toString()) {
    out.push(
      reject(
        'intent_match',
        `Plan amount ${String(action.args['amount'])} differs from intent ${spendAmount}`,
      ),
    );
  }

  if (intent.kind === 'swap') {
    try {
      const msg = JSON.parse(String(action.args['msg'])) as {
        actions?: Array<Record<string, unknown>>;
      };
      const leg = msg.actions?.[0];
      const ok =
        msg.actions?.length === 1 &&
        leg?.['pool_id'] === intent.poolId &&
        leg['token_in'] === intent.tokenIn &&
        leg['token_out'] === intent.tokenOut &&
        leg['amount_in'] === intent.amountIn.toString() &&
        leg['min_amount_out'] === intent.minAmountOut.toString();
      if (!ok) out.push(reject('intent_match', 'Swap message does not match the intent'));
    } catch {
      out.push(reject('intent_match', 'Swap message is not valid JSON'));
    }
  } else {
    const problem = burrowMessageProblem(intent, action.args['msg']);
    if (problem) out.push(reject('intent_match', problem));
  }
  return out;
};

const POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * A Burrow `ft_transfer_call` message is executed by the lending contract, so it must carry exactly the one action
 * the intent asked for: anything else in `Execute.actions` (e.g. a Withdraw or Borrow) would ride along unchecked.
 * Shapes follow `burrow-adapter/src/builders.ts`. `max_amount` is in Burrow inner units (token-specific extra
 * decimals the policy engine does not know), so only its form is checked; the contract caps it at the transfer.
 */
function burrowMessageProblem(
  intent: Exclude<ActionIntent, { kind: 'swap' }>,
  msg: unknown,
): string | null {
  if (typeof msg !== 'string') return 'Lending message is missing';
  if (intent.kind === 'lending.supply' && !intent.asCollateral) {
    return msg === '' ? null : 'Plain supply must use an empty message';
  }
  const expected = intent.kind === 'lending.repay' ? 'Repay' : 'IncreaseCollateral';
  let parsed: unknown;
  try {
    parsed = JSON.parse(msg);
  } catch {
    return 'Lending message is not valid JSON';
  }
  const execute = isRecord(parsed) && Object.keys(parsed).length === 1 ? parsed['Execute'] : null;
  const actions =
    isRecord(execute) && Object.keys(execute).length === 1 ? execute['actions'] : null;
  if (!Array.isArray(actions) || actions.length !== 1) {
    return `Lending message must contain exactly one ${expected} action`;
  }
  const [only] = actions as unknown[];
  const body = isRecord(only) && Object.keys(only).length === 1 ? only[expected] : null;
  if (!isRecord(body)) return `Lending message action is not ${expected}`;
  if (body['token_id'] !== intent.token) {
    return `Lending message token ${String(body['token_id'])} differs from intent ${intent.token}`;
  }
  const maxAmount = body['max_amount'];
  if (typeof maxAmount !== 'string' || !POSITIVE_INTEGER.test(maxAmount)) {
    return 'Lending message max_amount must be a positive integer string';
  }
  const extra = Object.keys(body).filter((k) => k !== 'token_id' && k !== 'max_amount');
  return extra.length === 0 ? null : `Lending message has unexpected fields: ${extra.join(', ')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const valueLimits: Rule = ({ valueUsdMicro, limits, history }) => {
  if (valueUsdMicro === null)
    return [reject('price_missing', 'Cannot value this action: oracle price missing')];
  const out: PolicyViolation[] = [];
  if (valueUsdMicro > limits.maxActionUsdMicro) {
    out.push(
      reject(
        'max_action_value',
        `Action value ${usd(valueUsdMicro)} exceeds per-action limit ${usd(limits.maxActionUsdMicro)}`,
      ),
    );
  } else if (valueUsdMicro > limits.approvalThresholdUsdMicro) {
    out.push(
      approval(
        'approval_threshold',
        `Action value ${usd(valueUsdMicro)} exceeds auto-approval threshold ${usd(limits.approvalThresholdUsdMicro)}`,
      ),
    );
  }
  if (history.spentLast24hUsdMicro + valueUsdMicro > limits.dailyLimitUsdMicro) {
    out.push(
      reject(
        'daily_limit',
        `Would exceed the 24h limit of ${usd(limits.dailyLimitUsdMicro)} (already ${usd(history.spentLast24hUsdMicro)})`,
      ),
    );
  }
  return out;
};

export const swapSlippage: Rule = ({ intent, config }) => {
  if (intent.kind !== 'swap') return [];
  const out: PolicyViolation[] = [];
  if (intent.slippageBps > config.maxSlippageBps) {
    out.push(
      reject(
        'max_slippage',
        `Slippage ${intent.slippageBps} bps exceeds limit ${config.maxSlippageBps} bps`,
      ),
    );
  }
  if (intent.minAmountOut > intent.quotedAmountOut) {
    out.push(reject('max_slippage', 'minAmountOut is above the quoted amount'));
  }
  // Independently of what the agent claims, the floor must be within the configured tolerance.
  if (
    intent.minAmountOut * 10_000n <
    intent.quotedAmountOut * BigInt(10_000 - config.maxSlippageBps)
  ) {
    out.push(reject('max_slippage', 'minAmountOut allows more slippage than policy permits'));
  }
  return out;
};

export const oracleDeviation: Rule = ({ intent, snapshot, config }) => {
  if (intent.kind !== 'swap') return [];
  try {
    const deviation = oracleDeviationBps({
      amountIn: intent.amountIn,
      priceIn: priceOf(snapshot.prices, intent.tokenIn),
      amountOut: intent.quotedAmountOut,
      priceOut: priceOf(snapshot.prices, intent.tokenOut),
    });
    return deviation > config.maxOracleDeviationBps
      ? [
          reject(
            'oracle_deviation',
            `Quote is ${deviation} bps worse than oracle (limit ${config.maxOracleDeviationBps})`,
          ),
        ]
      : [];
  } catch (error) {
    if (error instanceof MissingPriceError)
      return [reject('price_missing', `No oracle price for ${error.token}`)];
    throw error;
  }
};

/** Cooldown throttles discretionary trades only; de-risking must never be blocked by it. */
export const cooldown: Rule = ({ intent, history, config, now }) => {
  if (intent.kind !== 'swap' || !history.lastExecutedAt) return [];
  const elapsed = (now.getTime() - history.lastExecutedAt.getTime()) / 1000;
  return elapsed < config.cooldownSeconds
    ? [
        reject(
          'cooldown',
          `Last execution was ${Math.floor(elapsed)}s ago; cooldown is ${config.cooldownSeconds}s`,
        ),
      ]
    : [];
};

export const DEFAULT_RULES: readonly Rule[] = [
  killSwitch,
  signerRule,
  dataFreshness,
  nativeReserve,
  contractAllowlist,
  tokenAllowlist,
  actionShape,
  intentMatchesPlan,
  valueLimits,
  swapSlippage,
  oracleDeviation,
  cooldown,
];
