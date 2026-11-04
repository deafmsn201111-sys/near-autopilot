import {
  canonicalJson,
  type ActionIntent,
  type AssetBalance,
  type TokenId,
} from '@near-autopilot/core';
import { sha256Hex } from '@near-autopilot/core/hash';
import {
  WAD,
  assessLendingPosition,
  minAmountOut,
  tokenValueUsd,
  type LendingModel,
} from '@near-autopilot/financial-engine';
import { deriveLimits } from './config';
import { evaluateLpReposition } from './lp-economics';
import type { ParsedProposal } from './proposals';
import {
  afterRepay,
  afterSupply,
  assessRisk,
  buildLendingModel,
  hfOrInfinity,
  smallestAmountReaching,
  targetHfWad,
} from './risk-state';
import {
  MODE_RANK,
  RISK_RANK,
  stricterMode,
  type Advisory,
  type Candidate,
  type Caution,
  type Decision,
  type EvaluationInput,
  type Mode,
  type NoActionReason,
  type Rejection,
  type RejectionCode,
} from './types';

/**
 * The deterministic decision engine.
 *
 * `decide` is a pure function of its input: no clock, no randomness, no I/O, no ports. Calling it twice with the same
 * `EvaluationInput` returns the same `Decision` (including the ids, which are content hashes). It does not authorise
 * anything: its output is a ranked list of candidates for the policy engine to accept or reject.
 *
 * What it does with agent proposals:
 *   - It treats a proposal as a wish. Value, risk, sizing, benefit and cost are recomputed here from the snapshot,
 *     the market data and the quote. Anything an agent claimed about them is not in the proposal schema at all.
 *   - Untrusted inputs can only make it more conservative. A market signal can defer a discretionary trade but can
 *     never create or enlarge one; an LLM-sourced proposal can be rejected or shrunk, never expanded.
 *   - De-risking is only eligible when the ENGINE's own risk assessment says the position needs it.
 *   - "Do nothing" is a result, with reasons. It wins whenever no candidate clears the hurdle.
 *
 * Ranking is lexicographic: tier (de-risk in danger < de-risk at watch < discretionary), then higher estimated net
 * benefit, then the cheapest effective de-risk and the healthier resulting position, then the configured agent priority, then proposal id. Nothing is random and nothing depends on input order.
 */

const reject = (p: ParsedProposal, code: RejectionCode, detail: string): Rejection => ({
  proposalId: p.proposalId,
  agent: p.agent,
  kind: p.proposal.kind,
  code,
  detail,
});

const walletOf = (balances: readonly AssetBalance[]): Map<TokenId, bigint> => {
  const m = new Map<TokenId, bigint>();
  for (const b of balances) m.set(b.token, (m.get(b.token) ?? 0n) + b.raw);
  return m;
};

const actionKeyOf = (parts: unknown): string => sha256Hex(canonicalJson(parts));

export function computeInputsHash(input: EvaluationInput): string {
  return sha256Hex(
    canonicalJson({
      now: input.now,
      accountId: input.accountId,
      snapshot: input.snapshot,
      market: input.market,
      dataQuality: input.dataQuality,
      persistedMode: input.persistedMode,
      // Order-insensitive: the decision does not depend on the order proposals arrived in, so neither does its identity.
      proposals: input.proposals
        .map((p) => ({ id: p.proposalId, agent: p.agent, proposal: p.proposal }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      quarantined: [...input.quarantined].sort(),
      quotes: [...input.quotes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      recentActions: input.recentActions.map((a) => canonicalJson(a)).sort(),
      config: input.config,
    }),
  );
}

export function decide(input: EvaluationInput): Decision {
  const { config, snapshot, now } = input;
  const inputsHash = computeInputsHash(input);
  const risk = assessRisk(snapshot, config);
  const limits = deriveLimits(config);

  // ---- mode: the persisted mode can be tightened by the situation, never relaxed ----
  let effective: Mode = input.persistedMode;
  let because = `persisted mode is ${input.persistedMode}`;
  if (
    RISK_RANK[risk.level] >= RISK_RANK.danger &&
    MODE_RANK[effective] < MODE_RANK.risk_reduction_only
  ) {
    effective = stricterMode(effective, 'risk_reduction_only');
    because = `position risk is ${risk.level}`;
  }
  const mode = { persisted: input.persistedMode, effective, because };

  const finish = (partial: {
    outcome: 'act' | 'no_action';
    reasons: NoActionReason[];
    ranked?: Candidate[];
    wouldHaveActed?: Candidate | null;
    advisories?: Advisory[];
    rejected?: Rejection[];
    agentNoActions?: { agent: ParsedProposal['agent']; reasonCode: string }[];
    cautions?: Caution[];
  }): Decision => {
    const ranked = partial.ranked ?? [];
    const decisionId = sha256Hex(
      canonicalJson({
        inputsHash,
        outcome: partial.outcome,
        ranked: ranked.map((c) => c.proposalId),
      }),
    );
    return {
      decisionId,
      inputsHash,
      at: now,
      accountId: input.accountId,
      outcome: partial.outcome,
      reasons: partial.reasons,
      mode,
      risk,
      dataQuality: input.dataQuality,
      ranked,
      wouldHaveActed: partial.wouldHaveActed ?? null,
      advisories: partial.advisories ?? [],
      rejected: partial.rejected ?? [],
      agentNoActions: partial.agentNoActions ?? [],
      cautions: partial.cautions ?? [],
    };
  };

  // ---- stale or inconsistent data: no action of any kind ----
  if (input.dataQuality.blocking)
    return finish({ outcome: 'no_action', reasons: ['DATA_NOT_FRESH'] });

  const proposals = [...input.proposals].sort((a, b) =>
    a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0,
  );
  const rejected: Rejection[] = [];
  const agentNoActions: { agent: ParsedProposal['agent']; reasonCode: string }[] = [];
  const advisories: Advisory[] = [];
  const candidates: Candidate[] = [];

  // ---- signals: they can only add caution ----
  const cautions: Caution[] = [];
  for (const p of proposals) {
    if (p.proposal.kind !== 'market.signal') continue;
    if (input.quarantined.has(p.agent)) continue;
    if (p.proposal.validUntil.getTime() <= now.getTime()) {
      rejected.push(reject(p, 'MARKET_DATA_STALE', 'signal has expired'));
      continue;
    }
    cautions.push({
      token: p.proposal.token,
      signal: p.proposal.signal,
      severity: p.proposal.severity,
      agent: p.agent,
    });
  }
  const severityOn = (...tokens: TokenId[]): number =>
    cautions
      .filter((c) => tokens.includes(c.token))
      .reduce((max, c) => (c.severity > max ? c.severity : max), 0);

  const built = buildLendingModel(snapshot);
  const model: LendingModel | null = built.ok ? built.model : null;
  const wallet = walletOf(snapshot.walletBalances);
  const target = targetHfWad(config);
  const hfOf = (m: LendingModel): bigint | null => assessLendingPosition(m).healthFactorWad;
  const needsDeRisking = RISK_RANK[risk.level] >= RISK_RANK.watch;
  const windowMs = config.execution.dedupeWindowSeconds * 1000;
  const duplicate = (key: string): boolean =>
    input.recentActions.some(
      (a) =>
        a.actionKey === key &&
        (a.status === 'in_flight' || a.status === 'executed' || a.status === 'pending_approval') &&
        now.getTime() - a.at.getTime() < windowMs,
    );

  // A risk reduction that was sent after this snapshot was taken is not yet visible in it. Acting again on the same
  // picture (even with a different action) could double-correct, so risk reductions wait for a fresher snapshot.
  const deriskAfterSnapshot = input.recentActions.some(
    (a) =>
      (a.kind === 'lending.repay' || a.kind === 'lending.supply_collateral') &&
      (a.status === 'in_flight' || a.status === 'executed') &&
      now.getTime() - a.at.getTime() < windowMs &&
      a.at.getTime() >= snapshot.takenAt.getTime(),
  );

  for (const p of proposals) {
    const prop = p.proposal;
    if (prop.kind === 'market.signal') continue;
    if (input.quarantined.has(p.agent)) {
      rejected.push(reject(p, 'AGENT_QUARANTINED', `${p.agent} is quarantined`));
      continue;
    }

    switch (prop.kind) {
      case 'no_action':
        agentNoActions.push({ agent: p.agent, reasonCode: prop.reasonCode });
        break;

      case 'lp.reposition': {
        const view = input.market?.lpPositions.find((v) => v.id === prop.positionId);
        if (!input.dataQuality.marketUsable)
          rejected.push(
            reject(p, 'MARKET_DATA_STALE', 'market data is not fresh enough to judge a position'),
          );
        else if (!view)
          rejected.push(reject(p, 'UNKNOWN_POSITION', `no position ${prop.positionId}`));
        else {
          const ev = evaluateLpReposition(view, prop.tickLower, prop.tickUpper, config);
          if (!ev.ok) rejected.push(reject(p, ev.code, ev.detail));
          else {
            // Advisory only: this repository has no transaction planner for liquidity management, so there is no
            // path from here to a signed transaction. A human acts on it.
            advisories.push({
              proposalId: p.proposalId,
              agent: p.agent,
              kind: 'lp.reposition',
              positionId: prop.positionId,
              tickLower: prop.tickLower,
              tickUpper: prop.tickUpper,
              paybackDays: ev.paybackDays,
              costQuote: ev.costQuote,
              extraFeesPerDayQuote: ev.extraFeesPerDayQuote,
              note: ev.note,
            });
          }
        }
        break;
      }

      case 'lending.repay': {
        if (!needsDeRisking || !model) {
          rejected.push(
            reject(p, 'NOT_JUSTIFIED', `position risk is ${risk.level}; repaying is not warranted`),
          );
          break;
        }
        if (deriskAfterSnapshot) {
          rejected.push(
            reject(
              p,
              'AWAITING_FRESH_STATE',
              'a risk-reducing action was sent after this snapshot was taken; waiting for a fresher one',
            ),
          );
          break;
        }
        const debt = model.debt.find((d) => d.id === prop.token);
        if (!debt) {
          rejected.push(reject(p, 'NO_DEBT_FOR_TOKEN', `no debt in ${prop.token}`));
          break;
        }
        const held = wallet.get(prop.token) ?? 0n;
        if (held <= 0n) {
          rejected.push(reject(p, 'INSUFFICIENT_BALANCE', `wallet holds no ${prop.token}`));
          break;
        }
        const max = [prop.amount, held, debt.amount].reduce((a, b) => (b < a ? b : a));
        const final = smallestAmountReaching(max, target, (a) =>
          hfOf(afterRepay(model, prop.token, a)),
        );
        const before = risk.healthFactorWad;
        const after = hfOf(afterRepay(model, prop.token, final));
        if (final <= 0n || hfOrInfinity(after) <= hfOrInfinity(before)) {
          rejected.push(
            reject(p, 'NO_IMPROVEMENT', 'repaying this amount does not improve the health factor'),
          );
          break;
        }
        const key = actionKeyOf({ kind: prop.kind, token: prop.token, amount: final });
        if (duplicate(key)) {
          rejected.push(
            reject(p, 'DUPLICATE_ACTION', 'the same action was already taken or is in flight'),
          );
          break;
        }
        candidates.push({
          proposalId: p.proposalId,
          agent: p.agent,
          rationale: prop.rationale,
          action: { kind: 'lending.repay', token: prop.token, amount: final },
          tier: RISK_RANK[risk.level] >= RISK_RANK.danger ? 0 : 1,
          netBenefitUsdMicro: 0n,
          basis: 'risk_reduction',
          economics: null,
          riskEffect: {
            hfBeforeWad: before,
            hfAfterWad: after,
            valueUsedUsdMicro: tokenValueUsd(snapshot.prices, prop.token, final),
          },
          sizing: { requested: prop.amount, final },
          actionKey: key,
        });
        break;
      }

      case 'lending.supply_collateral': {
        if (!needsDeRisking || !model) {
          rejected.push(
            reject(
              p,
              'NOT_JUSTIFIED',
              `position risk is ${risk.level}; adding collateral is not warranted`,
            ),
          );
          break;
        }
        if (deriskAfterSnapshot) {
          rejected.push(
            reject(
              p,
              'AWAITING_FRESH_STATE',
              'a risk-reducing action was sent after this snapshot was taken; waiting for a fresher one',
            ),
          );
          break;
        }
        const riskParams = snapshot.risk.get(prop.token);
        if (!riskParams?.canBeCollateral || !snapshot.prices.has(prop.token)) {
          rejected.push(
            reject(
              p,
              riskParams ? 'NOT_COLLATERAL_ELIGIBLE' : 'NO_PRICE',
              `${prop.token} cannot be added as collateral`,
            ),
          );
          break;
        }
        const held = wallet.get(prop.token) ?? 0n;
        if (held <= 0n) {
          rejected.push(reject(p, 'INSUFFICIENT_BALANCE', `wallet holds no ${prop.token}`));
          break;
        }
        const max = prop.amount < held ? prop.amount : held;
        const hypothetical = (a: bigint): bigint | null => {
          const m = afterSupply(model, snapshot, prop.token, a);
          return m ? hfOf(m) : null;
        };
        const final = smallestAmountReaching(max, target, hypothetical);
        const before = risk.healthFactorWad;
        const after = hypothetical(final);
        if (final <= 0n || after === null || hfOrInfinity(after) <= hfOrInfinity(before)) {
          rejected.push(
            reject(p, 'NO_IMPROVEMENT', 'supplying this amount does not improve the health factor'),
          );
          break;
        }
        const key = actionKeyOf({ kind: prop.kind, token: prop.token, amount: final });
        if (duplicate(key)) {
          rejected.push(
            reject(p, 'DUPLICATE_ACTION', 'the same action was already taken or is in flight'),
          );
          break;
        }
        candidates.push({
          proposalId: p.proposalId,
          agent: p.agent,
          rationale: prop.rationale,
          action: { kind: 'lending.supply_collateral', token: prop.token, amount: final },
          tier: RISK_RANK[risk.level] >= RISK_RANK.danger ? 0 : 1,
          netBenefitUsdMicro: 0n,
          basis: 'risk_reduction',
          economics: null,
          riskEffect: {
            hfBeforeWad: before,
            hfAfterWad: after,
            valueUsedUsdMicro: tokenValueUsd(snapshot.prices, prop.token, final),
          },
          sizing: { requested: prop.amount, final },
          actionKey: key,
        });
        break;
      }

      case 'allocation.swap': {
        if (prop.tokenIn === prop.tokenOut) {
          rejected.push(reject(p, 'SAME_TOKEN', 'tokenIn equals tokenOut'));
          break;
        }
        if (RISK_RANK[risk.level] >= RISK_RANK.watch) {
          rejected.push(
            reject(
              p,
              'RISK_NOT_HEALTHY',
              `discretionary trading is suspended while position risk is ${risk.level}`,
            ),
          );
          break;
        }
        if (effective === 'risk_reduction_only') {
          rejected.push(
            reject(
              p,
              'MODE_RISK_REDUCTION_ONLY',
              'only risk-reducing actions are allowed in this mode',
            ),
          );
          break;
        }
        if (!input.dataQuality.marketUsable || !input.market) {
          rejected.push(
            reject(
              p,
              'MARKET_DATA_STALE',
              'market data is not fresh enough for a discretionary trade',
            ),
          );
          break;
        }
        const caution = severityOn(prop.tokenIn, prop.tokenOut);
        if (caution >= 4) {
          rejected.push(
            reject(
              p,
              'SIGNAL_CAUTION',
              `a severity-${caution} market signal covers ${prop.tokenIn} or ${prop.tokenOut}`,
            ),
          );
          break;
        }
        if (!snapshot.prices.has(prop.tokenIn) || !snapshot.prices.has(prop.tokenOut)) {
          rejected.push(reject(p, 'NO_PRICE', 'both tokens need an oracle price'));
          break;
        }
        const held = wallet.get(prop.tokenIn) ?? 0n;
        if (prop.amountIn > held) {
          rejected.push(
            reject(
              p,
              'INSUFFICIENT_BALANCE',
              `wallet holds ${held} ${prop.tokenIn}, proposal needs ${prop.amountIn}`,
            ),
          );
          break;
        }
        const valueIn = tokenValueUsd(snapshot.prices, prop.tokenIn, prop.amountIn);
        if (valueIn > limits.maxSwapUsdMicro) {
          rejected.push(
            reject(
              p,
              'EXCEEDS_ORCHESTRATOR_LIMIT',
              `trade value ${valueIn} micro-USD exceeds ${limits.maxSwapUsdMicro}`,
            ),
          );
          break;
        }
        if (prop.maxSlippageBps > config.swap.maxSlippageBps) {
          rejected.push(
            reject(
              p,
              'SLIPPAGE_ABOVE_LIMIT',
              `${prop.maxSlippageBps} bps exceeds ${config.swap.maxSlippageBps} bps`,
            ),
          );
          break;
        }
        const quote = input.quotes.get(p.proposalId);
        if (!quote || quote.amountOut <= 0n || quote.amountIn !== prop.amountIn) {
          rejected.push(reject(p, 'NO_QUOTE', 'no usable quote for this exact amount'));
          break;
        }
        const yIn = input.market.estimatedYieldWad.get(prop.tokenIn);
        const yOut = input.market.estimatedYieldWad.get(prop.tokenOut);
        if (yIn === undefined || yOut === undefined) {
          rejected.push(reject(p, 'NO_YIELD_ESTIMATE', 'no yield estimate for one of the tokens'));
          break;
        }
        const valueOut = tokenValueUsd(snapshot.prices, prop.tokenOut, quote.amountOut);
        const shortfall = valueIn > valueOut ? valueIn - valueOut : 0n; // fee + impact + pool-vs-oracle gap, in USD
        if (valueIn > 0n && (shortfall * 10_000n) / valueIn > BigInt(config.swap.maxSlippageBps)) {
          rejected.push(
            reject(
              p,
              'QUOTE_WORSE_THAN_ORACLE',
              `quote is ${(shortfall * 10_000n) / valueIn} bps below oracle value`,
            ),
          );
          break;
        }
        // ESTIMATE: yield differential credited over a fixed horizon, linear, before any fees or compounding.
        const benefit = (valueIn * (yOut - yIn) * BigInt(config.swap.horizonDays)) / (365n * WAD);
        const cost = shortfall + limits.estimatedGasUsdMicro;
        const net = benefit - cost;
        const multiple = BigInt(config.swap.costCoverMultiple) * (caution === 3 ? 2n : 1n);
        if (net < limits.minNetBenefitUsdMicro || benefit < multiple * cost) {
          rejected.push(
            reject(
              p,
              'BELOW_HURDLE',
              `estimated benefit ${benefit} minus cost ${cost} = ${net} micro-USD; needs >= ${limits.minNetBenefitUsdMicro} and benefit >= ${multiple}x cost`,
            ),
          );
          break;
        }
        const key = actionKeyOf({
          kind: prop.kind,
          tokenIn: prop.tokenIn,
          tokenOut: prop.tokenOut,
          amountIn: prop.amountIn,
        });
        if (duplicate(key)) {
          rejected.push(
            reject(p, 'DUPLICATE_ACTION', 'the same trade was already made or is in flight'),
          );
          break;
        }
        candidates.push({
          proposalId: p.proposalId,
          agent: p.agent,
          rationale: prop.rationale,
          action: {
            kind: 'allocation.swap',
            tokenIn: prop.tokenIn,
            tokenOut: prop.tokenOut,
            amountIn: prop.amountIn,
            poolId: quote.poolId,
            quotedAmountOut: quote.amountOut,
            minAmountOut: minAmountOut(quote.amountOut, prop.maxSlippageBps),
            slippageBps: prop.maxSlippageBps,
          },
          tier: 2,
          netBenefitUsdMicro: net,
          basis: 'estimated',
          economics: { valueInUsdMicro: valueIn, benefitUsdMicro: benefit, costUsdMicro: cost },
          riskEffect: null,
          sizing: { requested: prop.amountIn, final: prop.amountIn },
          actionKey: key,
        });
        break;
      }
    }
  }

  // ---- rank ----
  const priority = (a: ParsedProposal['agent']): number => {
    const i = config.agents.priority.indexOf(a);
    return i === -1 ? config.agents.priority.length : i;
  };
  const ranked = candidates.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.netBenefitUsdMicro !== b.netBenefitUsdMicro)
      return a.netBenefitUsdMicro > b.netBenefitUsdMicro ? -1 : 1;
    // Among risk reductions: the cheapest effective one (least wallet value consumed), then the healthier result.
    const ua = a.riskEffect?.valueUsedUsdMicro ?? 0n;
    const ub = b.riskEffect?.valueUsedUsdMicro ?? 0n;
    if (ua !== ub) return ua < ub ? -1 : 1;
    const ha = a.riskEffect ? hfOrInfinity(a.riskEffect.hfAfterWad) : 0n;
    const hb = b.riskEffect ? hfOrInfinity(b.riskEffect.hfAfterWad) : 0n;
    if (ha !== hb) return ha > hb ? -1 : 1;
    if (priority(a.agent) !== priority(b.agent)) return priority(a.agent) - priority(b.agent);
    return a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0;
  });
  const executableRejections = rejected.filter(
    (r) => r.kind !== 'market.signal' && r.kind !== 'lp.reposition',
  );

  if (ranked.length === 0) {
    const reasons: NoActionReason[] = [];
    if (advisories.length > 0) reasons.push('NO_EXECUTABLE_ACTION');
    else if (executableRejections.length > 0) reasons.push('ALL_PROPOSALS_REJECTED');
    else reasons.push('NOTHING_PROPOSED');
    if (effective === 'read_only') reasons.unshift('READ_ONLY_MODE');
    return finish({
      outcome: 'no_action',
      reasons,
      advisories,
      rejected,
      agentNoActions,
      cautions,
    });
  }
  if (effective === 'read_only') {
    return finish({
      outcome: 'no_action',
      reasons: ['READ_ONLY_MODE'],
      wouldHaveActed: ranked[0] ?? null,
      advisories,
      rejected,
      agentNoActions,
      cautions,
    });
  }
  return finish({
    outcome: 'act',
    reasons: [],
    ranked: ranked.slice(0, config.execution.maxAuthorizationAttempts),
    advisories,
    rejected,
    agentNoActions,
    cautions,
  });
}

/**
 * Candidate -> the intent the existing planners and policy engine understand. The id is derived from the decision,
 * so replaying the same decision produces the same intent and therefore the same plan hash.
 */
export function candidateToIntent(
  candidate: Candidate,
  decisionId: string,
  rank: number,
): ActionIntent {
  const base = {
    id: `${decisionId.slice(0, 20)}-${rank}`,
    agentId: `orchestrator/${candidate.agent}`,
    reason: candidate.rationale.slice(0, 300),
  };
  const a = candidate.action;
  switch (a.kind) {
    case 'lending.repay':
      return {
        ...base,
        kind: 'lending.repay',
        protocol: 'burrow',
        token: a.token,
        amount: a.amount,
      };
    case 'lending.supply_collateral':
      return {
        ...base,
        kind: 'lending.supply',
        protocol: 'burrow',
        token: a.token,
        amount: a.amount,
        asCollateral: true,
      };
    case 'allocation.swap':
      return {
        ...base,
        kind: 'swap',
        protocol: 'rhea',
        tokenIn: a.tokenIn,
        tokenOut: a.tokenOut,
        amountIn: a.amountIn,
        poolId: a.poolId,
        quotedAmountOut: a.quotedAmountOut,
        minAmountOut: a.minAmountOut,
        slippageBps: a.slippageBps,
      };
  }
}
