/**
 * Provenance of a financial VALUE (brief §5): where a number came from and how much it can be trusted. This is the
 * shared vocabulary the UI uses to never present an estimate or a prediction as a verified on-chain fact. It is a
 * label on a value, distinct from `Provenance` (the data SOURCE of a whole run: chain vs simulation, and network).
 */

export const PROVENANCE_TIERS = [
  'on_chain_verified',
  'external_market',
  'protocol_reported',
  'calculated_estimate',
  'ai_prediction',
] as const;
export type ProvenanceTier = (typeof PROVENANCE_TIERS)[number];

/** How strongly a tier may be stated. `fact` is read from the chain; everything else is softer and must say so. */
export type ProvenanceTrust = 'fact' | 'external' | 'estimate' | 'prediction';

export interface ProvenanceTierInfo {
  readonly tier: ProvenanceTier;
  readonly label: string;
  readonly trust: ProvenanceTrust;
  readonly describe: string;
}

export const PROVENANCE_TIER_INFO: Readonly<Record<ProvenanceTier, ProvenanceTierInfo>> = {
  on_chain_verified: {
    tier: 'on_chain_verified',
    label: 'On-chain',
    trust: 'fact',
    describe: 'Read directly from NEAR: balances, pool reserves, lending positions.',
  },
  external_market: {
    tier: 'external_market',
    label: 'Market price',
    trust: 'external',
    describe: 'A price from an oracle or exchange, cross-checked across sources.',
  },
  protocol_reported: {
    tier: 'protocol_reported',
    label: 'Protocol-reported',
    trust: 'external',
    describe: 'A figure a protocol or aggregator publishes, such as a yield.',
  },
  calculated_estimate: {
    tier: 'calculated_estimate',
    label: 'Estimate',
    trust: 'estimate',
    describe: 'Computed by us from the above — net APY, risk score, health factor. Not a promise.',
  },
  ai_prediction: {
    tier: 'ai_prediction',
    label: 'Model prediction',
    trust: 'prediction',
    describe: 'Produced by a model. Not used today — the agents are deterministic.',
  },
};

export const describeProvenance = (tier: ProvenanceTier): ProvenanceTierInfo =>
  PROVENANCE_TIER_INFO[tier];
