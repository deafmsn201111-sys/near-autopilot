import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_TIERS,
  PROVENANCE_TIER_INFO,
  describeProvenance,
  type ProvenanceTier,
} from '../src/provenance';

describe('provenance tiers', () => {
  it('has consistent info for every tier, keyed by the tier', () => {
    expect(Object.keys(PROVENANCE_TIER_INFO).sort()).toEqual([...PROVENANCE_TIERS].sort());
    for (const tier of PROVENANCE_TIERS) {
      const info = PROVENANCE_TIER_INFO[tier];
      expect(info.tier).toBe(tier);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.describe.length).toBeGreaterThan(0);
    }
  });

  it('marks only on-chain data as a fact; everything else is softer', () => {
    expect(PROVENANCE_TIER_INFO.on_chain_verified.trust).toBe('fact');
    for (const tier of PROVENANCE_TIERS) {
      if (tier === 'on_chain_verified') continue;
      expect(PROVENANCE_TIER_INFO[tier].trust).not.toBe('fact');
    }
    // A model prediction is the softest tier, and the app does not use it today.
    expect(PROVENANCE_TIER_INFO.ai_prediction.trust).toBe('prediction');
  });

  it('describeProvenance returns the tier info', () => {
    const t: ProvenanceTier = 'calculated_estimate';
    expect(describeProvenance(t)).toBe(PROVENANCE_TIER_INFO[t]);
  });
});
