import type { LlmModel } from '@near-autopilot/config';
import type { LlmUsage } from '@near-autopilot/orchestrator';

interface Rate {
  /** Micro-USD per million tokens, i.e. USD per million tokens × 1e6. */
  readonly input: bigint;
  readonly output: bigint;
}

/** NEAR AI Cloud list prices (GET https://cloud-api.near.ai/v1/model/list, 14 Nov 2026). */
const PRICES: Record<LlmModel, Rate> = {
  'z-ai/glm-5.3-flash': { input: 80_000n, output: 500_000n },
};

/** The cost of one model call in micro-USD, rounded up. */
export function costMicroUsd(model: LlmModel, usage: LlmUsage): bigint {
  const rate = PRICES[model];
  const total = BigInt(usage.inputTokens) * rate.input + BigInt(usage.outputTokens) * rate.output;
  return (total + 999_999n) / 1_000_000n;
}
