import { describe, expect, it } from 'vitest';
import {
  DCL_FEE_TIERS,
  DCL_UNIMPLEMENTED_METHODS,
  DCL_VERIFIED_CALL_METHODS,
  DCL_VERIFIED_VIEW_METHODS,
} from '../src';

describe('constants', () => {
  it('never marks a method both verified and unimplemented', () => {
    const verified = new Set<string>([...DCL_VERIFIED_VIEW_METHODS, ...DCL_VERIFIED_CALL_METHODS]);
    for (const m of DCL_UNIMPLEMENTED_METHODS) expect(verified.has(m)).toBe(false);
  });

  it('has the four fee tiers from ref-sdk', () => {
    expect([...DCL_FEE_TIERS]).toEqual([100, 400, 2000, 10000]);
  });
});
