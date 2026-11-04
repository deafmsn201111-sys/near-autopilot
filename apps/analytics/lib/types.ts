/** Shapes of the analytics API responses (apps/api/src/analytics/server.ts). */
export interface SourceRun {
  source: string;
  health: string;
  detail: string | null;
  records?: number;
  durationMs?: number;
}

export interface Overview {
  banner: string;
  generatedAt: string;
  collector: {
    running: boolean;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    nextRunAt: string | null;
    lastDurationMs: number | null;
    successfulCycles: number;
    partialCycles: number;
    failedCycles: number;
    lastError: string | null;
    collectedRecords: number;
    activeSources: string[];
    sources: SourceRun[];
    intervalSeconds: number;
    cyclesShown: number;
  };
  snapshot: {
    id: string;
    blockHeight: number;
    blockTimestamp: string;
    takenAt: string;
    ageSeconds: number;
    summary: {
      prices?: { token: string; usd: string; quality: string; source: string }[];
      pricedTokens?: number;
      pools?: number;
      markets?: number;
    };
  } | null;
  rhea: {
    discovered: number;
    active: number;
    byCategory: Record<string, number>;
    byFamily: Record<string, number>;
    liquid: number;
    lpEligible: number;
  };
  burrow: {
    markets: number;
    supported: number;
    withRewards: number;
    byStatus: Record<string, number>;
    opportunities: number;
  };
  portfolios: { portfolioId: string; outcome: string | null; runId: string | null }[];
}

export interface FeeWindow {
  window: string;
  quality: string;
  reason: string | null;
  observations: number;
  startAt: string | null;
  endAt: string | null;
  seconds: number | null;
  volumeUsd: string | null;
  grossFeesUsd: string | null;
  adminFeesUsd: string | null;
  lpFeesUsd: string | null;
  avgTvlUsd: string | null;
  endTvlUsd: string | null;
  realizedYield: string | null;
  annualizedApr: string | null;
  confidence: string | null;
}

export interface Pool {
  poolKey: string;
  family: string;
  poolType: string;
  tokens: string[];
  feeBps: number | null;
  tvlUsd: string | null;
  priceQuality: string;
  category: string;
  modelStatus: string;
  reasons: { code: string; detail: string }[];
  active: boolean;
  lastSeenAt: string;
  tracked: boolean;
  tvlMethod: string | null;
  historySeconds: number;
  windows: FeeWindow[];
}

export interface Market {
  token: string;
  status: string;
  inExecutionAllowlist: boolean;
  supplyApr: string | null;
  borrowApr: string | null;
  rewardApr: string | null;
  netSupplyApr: string | null;
  utilization: string | null;
  availableUsd: string | null;
  collateralFactor: number;
  reserveRatio: number;
  canDeposit: boolean;
  canWithdraw: boolean;
  canBorrow: boolean;
  canUseAsCollateral: boolean;
  suppliedLimitInner: string | null;
  borrowedLimitInner: string | null;
  activeRewardProgrammes: number;
  risk: string[];
  reasons: { code: string; detail: string }[];
  note: string;
  lastSeenAt: string;
}

export interface PriceObs {
  priceUsd: string | null;
  confidence: string | null;
  publishedAt: string | null;
  observedAt: string;
  ageMs: number | null;
  status: string;
  reason: string | null;
  sourceAssetId: string;
}

export interface PriceRow {
  asset: string;
  curated: boolean;
  divergenceBps: number | null;
  maxDeviationBps: number | null;
  status: string;
  pyth: PriceObs | null;
  defillama: PriceObs | null;
}

export interface LpSim {
  poolKey: string;
  status: string;
  reason: string | null;
  capitalUsd: number;
  horizonDays: number;
  window: string | null;
  poolShare: string | null;
  tokenSplit: string[] | null;
  expectedFeesUsd: string | null;
  rewardsUsd: string;
  rewardsNote: string;
  priceMoveAssumed: string | null;
  impermanentLossUsd: string | null;
  entryCostUsd: string | null;
  exitCostUsd: string | null;
  gasUsd: string | null;
  netReturnUsd: string | null;
  netReturnPct: string | null;
  confidence: string | null;
  risks: string[];
  assumptions: string;
}

export interface Strategy {
  strategy: string;
  label: string;
  capitalUsd: number;
  horizonDays: number;
  grossReturnUsd: number | null;
  feesUsd: number;
  rewardsUsd: number;
  impermanentLossUsd: number;
  gasUsd: number;
  slippageUsd: number;
  netReturnUsd: number | null;
  liquidityRisk: string;
  confidence: string | null;
  basis: string;
  reasonCodes: string[];
}

export interface Rejection {
  code: string;
  kind: string;
  agent: string;
  detail: string;
  economics?: Record<string, string>;
}

export interface Analysis {
  id: string;
  snapshotId: string;
  portfolioId: string;
  runId: string | null;
  createdAt: string;
  outcome: string | null;
  result: {
    portfolio: { id: string; description: string; walletUsd: number | null; capitalUsd: number };
    decision: {
      outcome: string;
      reasons: string[];
      risk: { level: string; healthFactorWad: string | null; ltvBps: string | null };
      rejected: Rejection[];
      ranked: unknown[];
      agentNoActions: { agent: string; reasonCode: string }[];
      wouldHaveActed: unknown;
    } | null;
    runStatus: string;
    executionMode: string;
    lpSimulations: LpSim[];
    strategies: Strategy[];
  };
}
