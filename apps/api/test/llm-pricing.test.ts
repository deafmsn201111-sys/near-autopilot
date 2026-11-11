import { describe, expect, it } from 'vitest';
import { costMicroUsd } from '../src/llm/pricing';

describe('costMicroUsd', () => {
  it('prices Haiku 5.5 at $0.10 / $0.50 per million tokens up to a 100K-token prompt', () => {
    expect(costMicroUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 100_000 })).toBe(
      60_000n,
    );
  });

  it('prices Haiku 5.5 prompts over 100K tokens at $0.50 / $2.50', () => {
    expect(costMicroUsd('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 1_000 })).toBe(
      102_500n,
    );
  });

  it('prices Sonnet 5.5 at $2 / $10 per million tokens', () => {
    expect(costMicroUsd('claude-sonnet-5-5', { inputTokens: 1_000, outputTokens: 1_000 })).toBe(
      12_000n,
    );
  });

  it('rounds a fraction of a micro-dollar up', () => {
    expect(costMicroUsd('claude-haiku-5-5', { inputTokens: 1, outputTokens: 0 })).toBe(1n);
  });
});
