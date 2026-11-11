import type { LlmModel } from '@near-autopilot/config';
import type { LlmUsage } from '@near-autopilot/orchestrator';

interface Rate {
  /** Micro-USD per million tokens, i.e. USD per million tokens × 1e6. */
  readonly input: bigint;
  readonly output: bigint;
}

/** Anthropic first-party list prices (claude-api skill, cached 3 Nov 2026). */
const PRICES: Record<
  LlmModel,
  { readonly base: Rate; readonly long?: Rate; readonly longFrom?: number }
> = {
  'claude-haiku-5-5': {
    base: { input: 100_000n, output: 500_000n },
    long: { input: 500_000n, output: 2_500_000n },
    longFrom: 100_000,
  },
  'claude-sonnet-5-5': { base: { input: 2_000_000n, output: 10_000_000n } },
};

/** The cost of one model call in micro-USD, rounded up. */
export function costMicroUsd(model: LlmModel, usage: LlmUsage): bigint {
  const price = PRICES[model];
  const rate =
    price.long && price.longFrom !== undefined && usage.inputTokens > price.longFrom
      ? price.long
      : price.base;
  const total = BigInt(usage.inputTokens) * rate.input + BigInt(usage.outputTokens) * rate.output;
  return (total + 999_999n) / 1_000_000n;
}
