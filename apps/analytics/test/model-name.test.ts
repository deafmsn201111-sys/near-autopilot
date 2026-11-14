import { describe, expect, it } from 'vitest';
import { modelName } from '../lib/analysis-client';

describe('modelName', () => {
  it('turns a NEAR AI Cloud model id into its product name', () => {
    expect(modelName('z-ai/glm-5.3-flash')).toBe('GLM 5.3 Flash');
  });
  it('shows any other id as is', () => {
    expect(modelName('gpt-x')).toBe('gpt-x');
  });
});
