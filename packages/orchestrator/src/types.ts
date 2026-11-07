import type { AccountId, PortfolioSnapshot, TokenId, UnitPrice } from '@near-autopilot/core';
import type { LiquiditySegment } from '@near-autopilot/financial-engine';
import type { OrchestratorConfig } from './config';
import type { AgentId, ParsedProposal, SignalType } from './proposals';

/** Operating mode. Ordered by restriction: normal < risk_reduction_only < read_only. */
export type Mode = 'normal' | 'risk_reduction_only' | 'read_only';
export const MODE_RANK: Readonly<Record<Mode, number>> = {
  normal: 0,
  risk_reduction_only: 1,
  read_only: 2,
};
export const stricterMode = (a: Mode, b: Mode): Mode => (MODE_RANK[a] >= MODE_RANK[b] ? a : b);

/* ------------------------------ observation ------------------------------ */

/** State of one concentrated-liquidity position, supplied by a market provider. Quote units are the pool's quote token. */
export interface LpPositionView {
  readonly id: string;
  readonly sqrtPrice: bigint;
  readonly range: {
    readonly sqrtLower: bigint;
    readonly sqrtUpper: bigint;
    readonly liquidity: bigint;
  };
  /** Pool liquidity active at the current price (including this position if `activeIncludesPosition`). */
  readonly activePoolLiquidity: bigint;
  readonly activeIncludesPosition: boolean;
  readonly volume24hQuote: bigint;
  readonly feePpm: number;
  /** Order book to trade against when re-centring (snapshot; treated as static). */
  readonly segments: readonly LiquiditySegment[];
  readonly gasQuote: bigint;
}

/** Independent market data. Everything here is an input to be checked, not a fact the orchestrator can verify. */
export interface MarketContext {
  readonly asOf: Date;
  /** ESTIMATED annual yield per token as a WAD fraction (0.05 = 5%). */
  readonly estimatedYieldWad: ReadonlyMap<TokenId, bigint>;
  /** A second price source, used only to detect oracle problems. */
  readonly referencePrices: ReadonlyMap<TokenId, UnitPrice>;
  readonly volatility24hBps: ReadonlyMap<TokenId, number>;
  readonly lpPositions: readonly LpPositionView[];
  /**
   * Why data is missing, for the agents' explanations only (never used as data): per token, the reason it has no
   * yield estimate; for LP, a summary of the pools observed and why none is usable.
   */
  readonly notes?: {
    readonly yield?: ReadonlyMap<TokenId, string>;
    readonly lp?: string;
  };
  /** Ids of the source reports this context was built from (market prices, yields), recorded with each decision. */
  readonly provenance?: Readonly<Record<string, string>>;
}

export type RiskLevel =
  'none' | 'healthy' | 'watch' | 'danger' | 'critical' | 'liquidatable' | 'unknown';
export const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  none: 0,
  healthy: 0,
  unknown: 1,
  watch: 2,
  danger: 3,
  critical: 4,
  liquidatable: 5,
};

export interface RiskState {
  readonly level: RiskLevel;
  readonly healthFactorWad: bigint | null;
  readonly ltvBps: bigint | null;
  readonly collateralUsdMicro: bigint;
  readonly debtUsdMicro: bigint;
  readonly stress: readonly {
    readonly scenario: string;
    readonly healthFactorWad: bigint | null;
    readonly status: string;
  }[];
  readonly note: string | null;
}

/** What an agent is allowed to see: plain data, no ports, no capabilities. Each agent receives its own deep copy. */
export interface AgentObservation {
  readonly now: Date;
  readonly accountId: AccountId;
  readonly snapshot: PortfolioSnapshot;
  readonly market: MarketContext | null;
  readonly risk: RiskState;
  readonly config: OrchestratorConfig;
  /** Pairs an allowlisted pool connects (from the quote provider); absent when unknown. Plain data, copied per agent. */
  readonly swapPairs?: readonly (readonly [TokenId, TokenId])[];
}

/* ------------------------------ data quality ------------------------------ */

export type DataIssueCode =
  | 'SNAPSHOT_UNAVAILABLE'
  | 'SNAPSHOT_STALE'
  | 'PRICES_STALE'
  | 'FUTURE_TIMESTAMP'
  | 'ACCOUNT_MISMATCH'
  | 'MISSING_PRICES'
  | 'MISSING_RISK_PARAMS'
  | 'MARKET_STALE'
  | 'MARKET_UNAVAILABLE';

export interface DataIssue {
  readonly code: DataIssueCode;
  /** Blocking issues forbid every action. Non-blocking ones forbid only discretionary (non-risk-reducing) actions. */
  readonly blocking: boolean;
  readonly detail: string;
}

export interface DataQuality {
  readonly checkedAt: Date;
  readonly issues: readonly DataIssue[];
  readonly blocking: boolean;
  readonly marketUsable: boolean;
}

/* ------------------------------ decision ------------------------------ */

export type RejectionCode =
  | 'AGENT_QUARANTINED'
  | 'NOT_JUSTIFIED'
  | 'NO_DEBT_FOR_TOKEN'
  | 'INSUFFICIENT_BALANCE'
  | 'NO_PRICE'
  | 'NOT_COLLATERAL_ELIGIBLE'
  | 'NO_IMPROVEMENT'
  | 'MODE_RISK_REDUCTION_ONLY'
  | 'RISK_NOT_HEALTHY'
  | 'MARKET_DATA_STALE'
  | 'NO_QUOTE'
  | 'SAME_TOKEN'
  | 'SLIPPAGE_ABOVE_LIMIT'
  | 'EXCEEDS_ORCHESTRATOR_LIMIT'
  | 'NO_YIELD_ESTIMATE'
  | 'QUOTE_WORSE_THAN_ORACLE'
  | 'BELOW_HURDLE'
  | 'SIGNAL_CAUTION'
  | 'DUPLICATE_ACTION'
  | 'AWAITING_FRESH_STATE'
  | 'UNKNOWN_POSITION'
  | 'INVALID_RANGE'
  | 'LP_NOT_WORTH_IT'
  | 'ADVISORY_ONLY';

export interface Rejection {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly kind: string;
  readonly code: RejectionCode;
  readonly detail: string;
  /** For rejected trades: the numbers the hurdle was applied to (micro-USD), for audit and analytics. */
  readonly economics?: {
    readonly tokenIn: TokenId;
    readonly tokenOut: TokenId;
    readonly amountIn: bigint;
    readonly valueInUsdMicro: bigint;
    readonly benefitUsdMicro: bigint;
    readonly costUsdMicro: bigint;
    readonly netUsdMicro: bigint;
    readonly requiredMultiple: bigint;
    readonly minNetUsdMicro: bigint;
  };
}

export type CandidateAction =
  | { readonly kind: 'lending.repay'; readonly token: TokenId; readonly amount: bigint }
  | { readonly kind: 'lending.supply_collateral'; readonly token: TokenId; readonly amount: bigint }
  | { readonly kind: 'lending.supply'; readonly token: TokenId; readonly amount: bigint }
  | {
      readonly kind: 'allocation.swap';
      readonly tokenIn: TokenId;
      readonly tokenOut: TokenId;
      readonly amountIn: bigint;
      readonly poolId: number;
      readonly quotedAmountOut: bigint;
      readonly minAmountOut: bigint;
      readonly slippageBps: number;
    };

export interface Candidate {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly rationale: string;
  readonly action: CandidateAction;
  /** 0: de-risk while in danger or worse; 1: de-risk at watch; 2: discretionary. Lower tier always wins. */
  readonly tier: 0 | 1 | 2;
  /**
   * Engine-computed, micro-USD. For discretionary actions this is an ESTIMATE (basis 'estimated'); for risk reduction
   * it is 0 because the benefit is a health-factor improvement, reported in `riskEffect`.
   */
  readonly netBenefitUsdMicro: bigint;
  readonly basis: 'risk_reduction' | 'estimated';
  readonly economics: {
    readonly valueInUsdMicro: bigint;
    readonly benefitUsdMicro: bigint;
    readonly costUsdMicro: bigint;
  } | null;
  readonly riskEffect: {
    readonly hfBeforeWad: bigint | null;
    readonly hfAfterWad: bigint | null;
    /** Wallet value the action consumes (micro-USD). Among equal-tier risk reductions the cheapest effective one wins. */
    readonly valueUsedUsdMicro: bigint;
  } | null;
  /** Set when the engine used less than the agent asked for. */
  readonly sizing: { readonly requested: bigint; readonly final: bigint };
  /** Hash of the economic content, used for duplicate suppression. */
  readonly actionKey: string;
}

export interface Advisory {
  readonly proposalId: string;
  readonly agent: AgentId;
  readonly kind: 'lp.reposition';
  readonly positionId: string;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly paybackDays: bigint | null;
  readonly costQuote: bigint;
  readonly extraFeesPerDayQuote: bigint;
  readonly note: string;
}

export interface Caution {
  readonly token: TokenId;
  readonly signal: SignalType;
  readonly severity: number;
  readonly agent: AgentId;
}

export type NoActionReason =
  | 'DATA_NOT_FRESH'
  | 'READ_ONLY_MODE'
  | 'NOTHING_PROPOSED'
  | 'ALL_PROPOSALS_REJECTED'
  | 'NO_EXECUTABLE_ACTION';

export interface ModeView {
  readonly persisted: Mode;
  readonly effective: Mode;
  readonly because: string;
}

export interface Decision {
  readonly decisionId: string;
  readonly inputsHash: string;
  readonly at: Date;
  readonly accountId: AccountId;
  readonly outcome: 'act' | 'no_action';
  readonly reasons: readonly NoActionReason[];
  readonly mode: ModeView;
  readonly risk: RiskState;
  readonly dataQuality: DataQuality;
  /** Executable candidates, best first. For `act` the orchestrator tries them in this order. */
  readonly ranked: readonly Candidate[];
  /** What would have been chosen but was suppressed (read-only mode). Never executed. */
  readonly wouldHaveActed: Candidate | null;
  readonly advisories: readonly Advisory[];
  readonly rejected: readonly Rejection[];
  readonly agentNoActions: readonly { readonly agent: AgentId; readonly reasonCode: string }[];
  readonly cautions: readonly Caution[];
}

export interface QuoteInput {
  readonly poolId: number;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export interface RecentAction {
  readonly actionKey: string;
  readonly kind: string;
  readonly status: ActionStatus;
  readonly at: Date;
}

export type ActionStatus =
  'in_flight' | 'executed' | 'dry_run' | 'failed' | 'pending_approval' | 'rejected';

/** Everything the decision engine reads. It has no other inputs: no clock, no randomness, no I/O. */
export interface EvaluationInput {
  readonly now: Date;
  readonly accountId: AccountId;
  readonly snapshot: PortfolioSnapshot;
  readonly market: MarketContext | null;
  readonly dataQuality: DataQuality;
  readonly persistedMode: Mode;
  readonly proposals: readonly ParsedProposal[];
  readonly quarantined: ReadonlySet<AgentId>;
  /** Quotes the orchestrator fetched for swap proposals, keyed by proposalId. null = no route. */
  readonly quotes: ReadonlyMap<string, QuoteInput | null>;
  readonly recentActions: readonly RecentAction[];
  readonly config: OrchestratorConfig;
}
