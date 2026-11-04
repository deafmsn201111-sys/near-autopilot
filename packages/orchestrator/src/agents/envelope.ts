import type { AgentId } from '../proposals';
import type { AgentObservation } from '../types';

/** Builds the wire shape every agent returns. Amounts are decimal strings, exactly as an LLM would have to write them. */
export function envelope(
  agent: AgentId,
  obs: AgentObservation,
  proposals: Record<string, unknown>[],
): unknown {
  return { schemaVersion: 1, agent, asOf: obs.now.toISOString(), proposals };
}

export const noAction = (
  reasonCode: 'healthy' | 'no_edge' | 'insufficient_data' | 'within_threshold' | 'other',
  rationale: string,
) => ({
  kind: 'no_action',
  reasonCode,
  rationale,
});
