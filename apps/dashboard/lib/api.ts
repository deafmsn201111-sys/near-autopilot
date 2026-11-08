import 'server-only';
import {
  policyDtoSchema,
  portfolioDtoSchema,
  proposalsResponseSchema,
  runsResponseSchema,
  marketDataDtoSchema,
  yieldDataDtoSchema,
  triggerRunResponseSchema,
} from '@near-autopilot/core';
import type { ZodType } from 'zod';
import { getEnv } from './env';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
  const env = getEnv();
  let response: Response;
  try {
    response = await fetch(`${env.API_BASE_URL}${path}`, {
      ...init,
      cache: 'no-store',
      headers: { authorization: `Bearer ${env.API_TOKEN}`, ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(0, 'The autopilot API is unreachable.');
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      `The autopilot API returned ${response.status} for ${path}.`,
    );
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success)
    throw new ApiError(502, `The autopilot API returned an unexpected response for ${path}.`);
  return parsed.data;
}

export const getPortfolio = () => request('/v1/portfolio', portfolioDtoSchema);
export const getPolicy = () => request('/v1/policy', policyDtoSchema);
export const getRuns = (limit = 20) => request(`/v1/runs?limit=${limit}`, runsResponseSchema);
export const getMarketData = () => request('/v1/market-data', marketDataDtoSchema);
export const getYieldData = () => request('/v1/yield', yieldDataDtoSchema);
export const getProposals = (limit = 50) =>
  request(`/v1/proposals?limit=${limit}`, proposalsResponseSchema);
export const triggerRun = () => request('/v1/runs', triggerRunResponseSchema, { method: 'POST' });
