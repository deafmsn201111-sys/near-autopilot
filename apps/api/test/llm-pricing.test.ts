import { describe, expect, it } from 'vitest';
import { costMicroUsd } from '../src/llm/pricing';

describe('costMicroUsd', () => {
  it('prices GLM 5.3 Flash at $0.08 / $0.50 per million tokens', () => {
    expect(
      costMicroUsd('z-ai/glm-5.3-flash', { inputTokens: 100_000, outputTokens: 100_000 }),
    ).toBe(58_000n);
  });

  it('rounds a fraction of a micro-dollar up', () => {
    expect(costMicroUsd('z-ai/glm-5.3-flash', { inputTokens: 1, outputTokens: 0 })).toBe(1n);
  });
});
