import { RATE_LIMITED, withinLimit } from './public-demo';
import 'server-only';
import { tryApi } from './api';
import type { RecommendationIntent } from './recommendation-intent';

/** Shapes of the product endpoints (opportunities, control, activity, system). */
export type Level = 'low' | 'medium' | 'high';

/** One recommendation card from the account endpoint: the agents' what/why plus a concrete, one-click intent. */
export interface AccountRecommendation {
  id: string;
  kind: string;
  agent: string;
  severity: 'info' | 'warning';
  title: string;
  why: string;
  intent: RecommendationIntent;
}
export interface Opportunity {
  id: string;
  protocol: 'rhea' | 'burrow';
  kind: 'liquidity' | 'lending' | 'loop';
  title: string;
  tokens: string[];
  ref: string;
  grossApr: number | null;
  grossBasis: string;
  netApr: number | null;
  netBasis: string | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceConfidence: string;
  dataAgeSeconds: number;
  fresh: boolean;
  risk: {
    score: number;
    level: Level;
    factors: { name: string; value: number; weight: number; note: string }[];
  };
  confidence: { score: number; level: Level; notes: string[] };
  score: number;
  status: 'candidate' | 'watch' | 'insufficient_data';
  why: string;
  reasons: string[];
  limitations: string[];
  detail: Record<string, unknown>;
}
export interface OpportunityList {
  generatedAt: string;
  method: string;
  total: number;
  counts: { candidate: number; watch: number; insufficient_data: number };
  excluded: Record<string, number>;
  matching: number;
  opportunities: Opportunity[];
}
export interface ControlView {
  collector: {
    paused: boolean;
    reason: string;
    by: string | null;
    at: string | null;
    live: {
      running?: boolean;
      paused?: boolean;
      nextRunAt?: string;
      intervalSeconds?: number;
    } | null;
  };
  modes: {
    scope: string;
    mode: 'normal' | 'risk_reduction_only' | 'read_only';
    reason: string;
    since: string;
    changedBy: string;
    version: number;
    history: {
      version: number;
      at: string;
      mode: string;
      previousMode: string | null;
      reason: string;
      changedBy: string;
      auditSeq: number | null;
    }[];
  }[];
}
export interface ActivityItem {
  at: string;
  kind: string;
  title: string;
  result: string;
  explanation: string;
  tone: 'good' | 'neutral' | 'warning' | 'critical';
  environment: string | null;
  ref: string;
}
export interface SystemView {
  now: string;
  api: { ok: boolean };
  database: {
    ok: boolean;
    latencyMs: number | null;
    migrations: number | null;
    error: string | null;
  };
  collector: {
    lastStatus: string | null;
    lastStartedAt: string | null;
    lastSuccessAt: string | null;
    dataAgeSeconds: number | null;
    stale: boolean;
    intervalSeconds: number;
    last50: { success: number; partial: number; failed: number };
    sources: { source: string; health: string; detail: string | null; records?: number }[];
  };
}

export const opportunities = (qs = '') =>
  tryApi<OpportunityList>(`/v1/analytics/opportunities${qs ? `?${qs}` : ''}`);
export const opportunity = (id: string) =>
  tryApi<{
    opportunity: Opportunity;
    rank: number;
    of: number;
    history: Record<string, number | string | null>[];
  }>(`/v1/analytics/opportunities/${encodeURIComponent(id)}`);
export const control = () => tryApi<ControlView>('/v1/control');
export const activity = (limit = 50) =>
  tryApi<{ items: ActivityItem[] }>(`/v1/analytics/activity?limit=${limit}`);
export const system = () => tryApi<SystemView>('/v1/analytics/system');

/** "simulation:mainnet:shadow-demo.near:demo-500" -> a name a person understands. */
export function scopeName(scope: string): { name: string; env: string } {
  const [source, network, , portfolio] = scope.split(':');
  const env =
    source === 'simulation' && network === 'mainnet'
      ? 'Shadow mainnet'
      : source === 'simulation'
        ? 'Simulation'
        : `${source}:${network}`;
  return {
    name: portfolio ? `Demo portfolio ${portfolio.replace('demo-', '$')}` : 'Account',
    env,
  };
}

export const ago = (iso: string | null | undefined, nowIso?: string): string => {
  if (!iso) return '—';
  const s = Math.max(
    0,
    Math.round(((nowIso ? Date.parse(nowIso) : Date.now()) - Date.parse(iso)) / 1000),
  );
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};

export const inTime = (iso: string): string => {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (s <= 0) return 'due now';
  if (s < 90) return `in ${s} s`;
  return `in ${Math.round(s / 60)} min`;
};

export interface PortfolioAction {
  id: string;
  kind: 'lend' | 'liquidity' | 'loop' | 'keep';
  title: string;
  summary: string;
  capitalUsd: number;
  horizonDays: number;
  grossUsd: number | null;
  netUsd: number | null;
  netAprOnCapital: number | null;
  costs: { label: string; usd: number }[];
  risk: Level;
  steps: string[];
  risks: string[];
  basis: string;
  autopilot: { verdict: 'worth_it' | 'not_worth_it' | 'not_allowed' | 'no_data'; sentence: string };
}
export interface PortfolioView {
  id: 'demo-500' | 'demo-5000';
  label: string;
  simulated: true;
  asOf: string | null;
  holdings: {
    where: 'wallet' | 'collateral' | 'deposited' | 'borrowed';
    symbol: string;
    amount: number;
    usd: number | null;
  }[];
  totals: { assetsUsd: number; debtUsd: number; netWorthUsd: number; idleUsd: number };
  health: { healthFactor: number | null; level: Level; label: string; sentence: string };
  earnings: { monthlyNetUsd: number | null; sentence: string };
  actions: PortfolioAction[];
  lastDecision: { outcome: string | null; headline: string; notes: string[] } | null;
  simulatedChanges?: { count: number; since: string | null } | null;
}
export interface AgentEntry {
  from: string;
  to: string;
  count: number;
  headline: string;
  notes: string[];
  policy: { verdict: string; sentence: string }[];
}

export const portfolioView = (id: string) => tryApi<PortfolioView>(`/v1/analytics/portfolio/${id}`);
export const agentActivity = (portfolio: string) =>
  tryApi<{ entries: AgentEntry[] }>(
    `/v1/analytics/agent-activity?portfolio=${portfolio}&limit=300`,
  );

/** $1,234 / $12.34 with a real minus sign. */
export const money = (v: number | null | undefined, cents?: boolean): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const c = cents ?? Math.abs(v) < 100;
  const s = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: c ? 2 : 0,
    maximumFractionDigits: c ? 2 : 0,
  });
  return `${v < 0 && Number(s.replace(/,/g, '')) !== 0 ? '−' : ''}$${s}`;
};

/** A real mainnet account in the same shape as a demo portfolio (read-only; no agent history). */
export const accountView = async (id: string) => {
  if (!(await withinLimit('account'))) return { error: RATE_LIMITED, data: null };
  const r = await tryApi<
    Omit<PortfolioView, 'id' | 'label' | 'simulated' | 'lastDecision'> & { accountId: string }
  >(`/v1/analytics/account/${encodeURIComponent(id)}`);
  return {
    error: r.error,
    data: r.data
      ? ({
          ...r.data,
          id: 'demo-5000',
          label: r.data.accountId,
          simulated: true,
          lastDecision: null,
        } as PortfolioView)
      : null,
  };
};

/**
 * The connected wallet's portfolio recommendations from the real account endpoint, with each card's concrete intent.
 * Shares the endpoint with `accountView`; here we keep the recommendation list (what the agents suggest, with a
 * one-click intent) rather than the portfolio shape.
 */
export const accountRecommendations = (id: string) =>
  tryApi<{ accountId: string; recommendations: AccountRecommendation[] }>(
    `/v1/analytics/account/${encodeURIComponent(id)}`,
  );
