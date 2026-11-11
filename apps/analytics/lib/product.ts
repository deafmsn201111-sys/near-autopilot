import { ACCOUNT_LIMIT, consume, RATE_LIMITED, visitor } from './rate-limit';
import 'server-only';
import { tryApi } from './api';
import { cookies } from 'next/headers';
import { OWNERSHIP_COOKIE } from '@near-autopilot/core/ownership';
import type { RecommendationIntent } from './recommendation-intent';

/** Shapes of the product endpoints (opportunities, activity, system). */
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
export const activity = (limit = 50) =>
  tryApi<{ items: ActivityItem[] }>(`/v1/analytics/activity?limit=${limit}`);
export const system = () => tryApi<SystemView>('/v1/analytics/system');

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

type AccountRead = Omit<PortfolioView, 'id' | 'label' | 'simulated' | 'lastDecision'> & {
  accountId: string;
  recommendations: AccountRecommendation[];
  /** The visitor proved with a NEP-413 signature that they own this account: only then may the LLM analyse it. */
  ownerVerified: boolean;
};

type AccountResult = { data: AccountRead | null; error: string | null };

const ACCOUNT_TTL_MS = 60_000;
const accountReads = new Map<string, { at: number; read: Promise<AccountResult> }>();

const ownershipProof = async () => (await cookies()).get(OWNERSHIP_COOKIE)?.value ?? '';

const readKey = async (id: string, proof: string) =>
  `${await visitor()}:${id.trim().toLowerCase()}:${proof}`;

const fetchAccount = async (id: string, proof: string): Promise<AccountResult> => {
  if (!(await consume('account', ACCOUNT_LIMIT))) return { error: RATE_LIMITED, data: null };
  return tryApi<AccountRead>(
    `/v1/analytics/account/${encodeURIComponent(id)}`,
    proof ? { 'x-ownership-proof': proof } : {},
  );
};

const readAccount = async (id: string): Promise<AccountResult> => {
  const proof = await ownershipProof();
  const key = await readKey(id, proof);
  const now = Date.now();
  for (const [k, entry] of accountReads)
    if (now - entry.at >= ACCOUNT_TTL_MS) accountReads.delete(k);
  const cached = accountReads.get(key);
  if (cached) return cached.read;
  const entry = { at: Infinity, read: fetchAccount(id, proof) };
  accountReads.set(key, entry);
  const r = await entry.read;
  if (accountReads.get(key) !== entry) return r;
  if (r.error) accountReads.delete(key);
  else entry.at = Date.now();
  return r;
};

export const forgetAccount = async (id: string) => {
  accountReads.delete(await readKey(id, await ownershipProof()));
};

/** A real mainnet account in the same shape as a demo portfolio (read-only; no agent history). */
export const accountView = async (id: string) => {
  const r = await readAccount(id);
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
export const accountRecommendations = readAccount;
