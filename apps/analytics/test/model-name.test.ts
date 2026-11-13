import { describe, expect, it } from 'vitest';
import { modelName } from '../lib/analysis-client';

describe('modelName', () => {
  it('turns a Claude model id into its product name', () => {
    expect(modelName('claude-haiku-5-5')).toBe('Claude Haiku 5.5');
    expect(modelName('claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
  });
  it('shows any other id as is', () => {
    expect(modelName('gpt-x')).toBe('gpt-x');
  });
});
