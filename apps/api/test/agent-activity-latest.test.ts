import { describe, expect, it } from 'vitest';
import { mapAgentActivity } from '../src/analytics/agent-activity-latest';

const snapshot = {
  engine: 'orchestrator',
  agents: [
    {
      agent: 'market-intelligence',
      event: 'output',
      suspicious: false,
      proposals: [
        { kind: 'no_action', reasonCode: 'healthy', rationale: 'no abnormal conditions found' },
      ],
    },
    {
      agent: 'portfolio-intelligence',
      event: 'output',
      suspicious: false,
      proposals: [
        {
          kind: 'portfolio.signal',
          severity: 4,
          exposureBps: 9100,
          rationale: '91.0% of portfolio assets sit in a single token',
        },
      ],
    },
    {
      agent: 'capital-allocator',
      event: 'output',
      proposals: [{ kind: 'lending.supply' }], // no rationale -> falls back to the kind
    },
  ],
};

describe('mapAgentActivity', () => {
  it('returns an empty result for a missing row', () => {
    expect(mapAgentActivity(undefined)).toEqual({ run: null, decision: null, agents: [] });
  });

  it('extracts the decision summary (outcome, expiry, reasons) when present', () => {
    const out = mapAgentActivity({
      id: 'run-2',
      finishedAt: new Date('2026-11-08T12:00:00Z'),
      snapshot: {
        engine: 'orchestrator',
        cycleStatus: 'no_action',
        decisionId: 'abc123',
        expiresAt: '2026-11-08T12:01:00.000Z',
        reasons: ['NO_EXECUTABLE_ACTION'],
        agents: [],
      },
    });
    expect(out.decision).toEqual({
      id: 'abc123',
      outcome: 'no_action',
      expiresAt: '2026-11-08T12:01:00.000Z',
      reasons: ['NO_EXECUTABLE_ACTION'],
    });
  });

  it('maps each agent to its conclusions, preferring the agent’s own rationale', () => {
    const out = mapAgentActivity({
      id: 'run-1',
      finishedAt: new Date('2026-11-08T12:00:00Z'),
      snapshot,
    });
    expect(out.run).toEqual({ id: 'run-1', at: '2026-11-08T12:00:00.000Z' });
    expect(out.agents.map((a) => a.agent)).toEqual([
      'market-intelligence',
      'portfolio-intelligence',
      'capital-allocator',
    ]);
    expect(out.agents[0]?.conclusions).toEqual([
      { kind: 'no_action', text: 'no abnormal conditions found' },
    ]);
    // rationale wins over reason code; the concentration sentence is the agent's own text
    expect(out.agents[1]?.conclusions[0]?.text).toBe(
      '91.0% of portfolio assets sit in a single token',
    );
    // no rationale and no reason code -> the bare kind
    expect(out.agents[2]?.conclusions[0]).toEqual({
      kind: 'lending.supply',
      text: 'lending.supply',
    });
  });

  it('tolerates a snapshot without an agents array', () => {
    const out = mapAgentActivity({
      id: 'r',
      finishedAt: null,
      snapshot: { engine: 'orchestrator' },
    });
    expect(out.agents).toEqual([]);
    expect(out.run).toEqual({ id: 'r', at: '' });
  });
});
