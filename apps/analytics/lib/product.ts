import 'server-only';
import { tryApi } from './api';

/** Shapes of the product endpoints (opportunities, control, activity, system). */
export type Level = 'low' | 'medium' | 'high';
export interface Opportunity {
  id: string;
  protocol: 'rhea' | 'burrow';
  kind: 'liquidity' | 'lending';
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
        : network === 'testnet'
          ? 'Testnet'
          : `${source}:${network}`;
  return {
    name: portfolio ? `Demo portfolio ${portfolio.replace('demo-', '$')}` : 'Testnet account',
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
