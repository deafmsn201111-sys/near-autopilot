import { canonicalJson } from '@near-autopilot/core';
import { sha256Hex } from '@near-autopilot/core/hash';
import {
  checkDataQuality,
  type EvaluationInput,
  type Mode,
  type ParsedProposal,
  type Proposal,
  type AgentId,
  type QuoteInput,
} from '../../src';
import { ALICE, NOW, makeWorld, type World, type WorldOptions } from './world';

/** Builds a ParsedProposal the way the orchestrator does (content-derived id). */
export function prop(agent: AgentId, proposal: unknown, index = 0): ParsedProposal {
  const p = proposal as Proposal;
  return {
    agent,
    proposal: p,
    index,
    proposalId: sha256Hex(canonicalJson({ agent, proposal: p })),
  };
}

export const base = {
  rationale: 'test',
};

export interface InputOverrides {
  persistedMode?: Mode;
  quarantined?: ReadonlySet<AgentId>;
  quotes?: ReadonlyMap<string, QuoteInput | null>;
  recentActions?: EvaluationInput['recentActions'];
  now?: Date;
  snapshot?: EvaluationInput['snapshot'];
  market?: EvaluationInput['market'];
}

/** A complete EvaluationInput from a world's data, without involving the orchestrator at all. */
export function buildInput(
  proposals: readonly ParsedProposal[],
  world: World = makeWorld(),
  over: InputOverrides = {},
): EvaluationInput {
  const now = over.now ?? NOW;
  const snapshot = over.snapshot ?? world.buildSnapshot();
  const market = over.market === undefined ? world.buildMarket() : over.market;
  return {
    now,
    accountId: ALICE,
    snapshot,
    market,
    dataQuality: checkDataQuality({
      now,
      expectedAccount: ALICE,
      snapshot,
      market,
      config: world.config,
    }),
    persistedMode: over.persistedMode ?? 'normal',
    proposals,
    quarantined: over.quarantined ?? new Set(),
    quotes: over.quotes ?? new Map(),
    recentActions: over.recentActions ?? [],
    config: world.config,
  };
}

export const worldWith = (o: WorldOptions): World => makeWorld(o);
