import { BoundedMap } from '@near-autopilot/core';
import { ACCOUNT_LIMIT, consume, RATE_LIMITED, MAX_TRACKED_KEYS, visitor } from './rate-limit';
import 'server-only';
import { tryApi } from './api';
import { processWide } from './process-state';
import { cookies } from 'next/headers';
import { OWNERSHIP_COOKIE } from '@near-autopilot/core/ownership';
import { DEFAULT_STRATEGY, STRATEGY_IDS, type StrategyId } from '@near-autopilot/core/strategy';
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
  intent: RecommendationIntent | null;
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
    token?: string;
    symbol: string;
    amount: number;
    usd: number | null;
    verified?: boolean;
    estimate?: boolean;
    small?: boolean;
  }[];
  totals: { assetsUsd: number; debtUsd: number; netWorthUsd: number; idleUsd: number };
  health: { healthFactor: number | null; level: Level; label: string; sentence: string };
  /** Set when the chosen strategy changes nothing on this account: why the presets agree. */
  strategyNote?: string | null;
  earnings: { monthlyNetUsd: number | null; sentence: string };
  actions: PortfolioAction[];
  lastDecision: { outcome: string | null; headline: string; notes: string[] } | null;
  simulatedChanges?: { count: number; since: string | null } | null;
  metrics?: { byToken: { symbol: string; usd: number; pct: number }[] };
  positions?: {
    key: string;
    label: string;
    sub: string;
    amount: number | null;
    usd: number | null;
    verified?: boolean;
    estimate?: boolean;
    small?: boolean;
  }[];
  /** A real account: false when an indexer was down and only the allowlisted tokens and pools were read. */
  discovery?: { complete: boolean };
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

export { money } from './format';

type AccountRead = Omit<PortfolioView, 'id' | 'label' | 'simulated' | 'lastDecision'> & {
  accountId: string;
  recommendations: AccountRecommendation[];
  /** Actions the agents saw but skipped as too small, in plain language. */
  skipped?: string[];
  /** The visitor proved with a NEP-413 signature that they own this account: only then may the LLM analyse it. */
  ownerVerified: boolean;
};

type AccountResult = { data: AccountRead | null; error: string | null };

const ACCOUNT_TTL_MS = 60_000;
const accountReads = processWide(
  'accountReads',
  () => new Map<string, { at: number; read: Promise<AccountResult> }>(),
);
const lastHoldings = processWide(
  'lastHoldings',
  () => new BoundedMap<string, string>(MAX_TRACKED_KEYS),
);

// ponytail: 4 significant digits hide Burrow interest and gas; an action smaller than that waits out the retries
const holdingsOf = (r: AccountResult) =>
  r.data
    ? JSON.stringify([
        ...r.data.holdings.map((h) => [h.where, h.token, Number(h.amount.toPrecision(4))]),
        ...(r.data.positions ?? []).map((x) => [
          x.key,
          x.amount && Number(x.amount.toPrecision(4)),
        ]),
      ])
    : null;

const ownershipProof = async () => (await cookies()).get(OWNERSHIP_COOKIE)?.value ?? '';

const readKey = async (id: string, proof: string, strategy: StrategyId) =>
  `${await visitor()}:${id.trim().toLowerCase()}:${proof}:${strategy}`;

const holdingsKey = async (id: string, proof: string) =>
  `${await visitor()}:${id.trim().toLowerCase()}:${proof}`;

const fetchAccount = async (
  id: string,
  proof: string,
  strategy: StrategyId,
  fresh: boolean,
): Promise<AccountResult> => {
  if (!(await consume('account', ACCOUNT_LIMIT))) return { error: RATE_LIMITED, data: null };
  return tryApi<AccountRead>(
    `/v1/analytics/account/${encodeURIComponent(id)}?strategy=${strategy}${fresh ? '&fresh=1' : ''}`,
    proof ? { 'x-ownership-proof': proof } : {},
  );
};

const readAccount = async (
  id: string,
  strategy: StrategyId = DEFAULT_STRATEGY,
  fresh = false,
): Promise<AccountResult> => {
  const proof = await ownershipProof();
  const key = await readKey(id, proof, strategy);
  const now = Date.now();
  for (const [k, entry] of accountReads)
    if (now - entry.at >= ACCOUNT_TTL_MS) accountReads.delete(k);
  const cached = accountReads.get(key);
  if (cached && !fresh) return cached.read;
  const entry = { at: Infinity, read: fetchAccount(id, proof, strategy, fresh) };
  accountReads.set(key, entry);
  const r = await entry.read;
  if (accountReads.get(key) !== entry) return r;
  if (r.error) accountReads.delete(key);
  else entry.at = Date.now();
  const holdings = holdingsOf(r);
  if (holdings) lastHoldings.set(await holdingsKey(id, proof), holdings);
  return r;
};

export const forgetAccount = async (id: string) => {
  const proof = await ownershipProof();
  for (const strategy of STRATEGY_IDS) accountReads.delete(await readKey(id, proof, strategy));
};

/**
 * After a transaction: replaces this visitor's cached read with a fresh one (past the API cache, D20). True once the
 * holdings differ from the read it replaced, or when there is nothing to compare or the read failed, so the caller
 * stops retrying. Reads under other strategies are dropped; the next page render re-reads them from the fresh API cache.
 */
export const refreshAccountRead = async (id: string): Promise<boolean> => {
  const normalized = id.trim().toLowerCase();
  const before = lastHoldings.get(await holdingsKey(normalized, await ownershipProof()));
  await forgetAccount(normalized);
  const after = holdingsOf(await readAccount(normalized, DEFAULT_STRATEGY, true));
  return before === undefined || after === null || after !== before;
};

/** A real mainnet account in the same shape as a demo portfolio (read-only; no agent history). */
export const accountView = async (id: string, strategy?: StrategyId) => {
  const r = await readAccount(id, strategy);
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
