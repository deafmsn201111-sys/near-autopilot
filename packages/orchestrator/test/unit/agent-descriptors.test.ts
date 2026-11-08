import { describe, expect, it } from 'vitest';
import {
  ADVISORY_KINDS,
  AGENT_CAPABILITIES,
  AGENT_DESCRIPTORS,
  AGENT_IDS,
  describeAgent,
  type AgentId,
} from '../../src';

/**
 * The agent roster (brief §10) must stay consistent with the capability map it describes. These tests make it
 * impossible to add an agent, or change its permissions, without the human-facing description following along.
 */
describe('AGENT_DESCRIPTORS', () => {
  it('has exactly one descriptor per agent id, keyed by that id', () => {
    expect(Object.keys(AGENT_DESCRIPTORS).sort()).toEqual([...AGENT_IDS].sort());
    for (const id of AGENT_IDS) expect(AGENT_DESCRIPTORS[id].id).toBe(id);
  });

  it('describes exactly the permissions the capability map grants', () => {
    for (const id of AGENT_IDS) {
      expect(AGENT_DESCRIPTORS[id].proposalKinds).toEqual(AGENT_CAPABILITIES[id]);
    }
  });

  it('marks an agent advisoryOnly iff every permitted kind is advisory', () => {
    for (const id of AGENT_IDS) {
      const expected = AGENT_CAPABILITIES[id].every((k) => ADVISORY_KINDS.includes(k));
      expect(AGENT_DESCRIPTORS[id].advisoryOnly).toBe(expected);
    }
    // the reference roster: only Market Intelligence is advisory-only
    expect(AGENT_DESCRIPTORS['market-intelligence'].advisoryOnly).toBe(true);
    expect(AGENT_DESCRIPTORS['capital-allocator'].advisoryOnly).toBe(false);
  });

  it('carries a non-empty title/responsibility and a semver version', () => {
    for (const id of AGENT_IDS) {
      const d = AGENT_DESCRIPTORS[id];
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.responsibility.length).toBeGreaterThan(0);
      expect(d.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('describeAgent returns the descriptor for an id', () => {
    const id: AgentId = 'liquidation-guardian';
    expect(describeAgent(id)).toBe(AGENT_DESCRIPTORS[id]);
  });
});
