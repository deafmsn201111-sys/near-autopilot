import { describe, expect, it } from 'vitest';
import {
  DCL_CONTRACT_IDS,
  DCL_FEE_TIERS,
  DCL_TESTNET_CANDIDATES,
  DCL_UNIMPLEMENTED_METHODS,
  DCL_VERIFIED_CALL_METHODS,
  DCL_VERIFIED_VIEW_METHODS,
} from '../src';

describe('constants', () => {
  it('lists the default testnet contract first among candidates, without duplicates', () => {
    expect(DCL_TESTNET_CANDIDATES[0]).toBe(DCL_CONTRACT_IDS.testnet);
    expect(new Set(DCL_TESTNET_CANDIDATES).size).toBe(DCL_TESTNET_CANDIDATES.length);
  });

  it('never marks a method both verified and unimplemented', () => {
    const verified = new Set<string>([...DCL_VERIFIED_VIEW_METHODS, ...DCL_VERIFIED_CALL_METHODS]);
    for (const m of DCL_UNIMPLEMENTED_METHODS) expect(verified.has(m)).toBe(false);
  });

  it('has the four fee tiers from ref-sdk', () => {
    expect([...DCL_FEE_TIERS]).toEqual([100, 400, 2000, 10000]);
  });
});
