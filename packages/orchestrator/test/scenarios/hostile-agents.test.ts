import { describe, expect, it } from 'vitest';
import { LiquidationGuardianAgent, type ProposalAgent } from '../../src';
import { makeWorld, scriptedAgent, wire } from '../support/world';

const watch = { collateralNear: 100, debtUsdt: 230 };
const guardian = () => new LiquidationGuardianAgent();

describe('scenario: misbehaving agents cannot stop (or steer) the cycle', () => {
  it('an agent that throws is recorded and skipped; the guardian still protects the position', async () => {
    const boom: ProposalAgent = {
      id: 'market-intelligence',
      async propose() {
        throw new Error('model API 500');
      },
    };
    const w = makeWorld({ lending: watch, agents: [boom, guardian()] });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('dry_run');
    expect(await w.types()).toContain('agent.error');
  });

  it('an agent that never answers is cut off by the timeout, recorded, and skipped', async () => {
    const hang: ProposalAgent = {
      id: 'market-intelligence',
      propose: () => new Promise(() => undefined),
    };
    const w = makeWorld({
      lending: watch,
      agents: [hang, guardian()],
      config: { execution: { agentTimeoutMs: 40 } },
    });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('dry_run');
    expect(await w.types()).toContain('agent.timeout');
  });

  it('output that cannot even be serialised (circular object, raw bigint) does not abort the cycle', async () => {
    const circular: Record<string, unknown> = {
      schemaVersion: 1,
      agent: 'market-intelligence',
      asOf: new Date().toISOString(),
      proposals: [],
    };
    circular['self'] = circular;
    for (const weird of [
      circular,
      { schemaVersion: 1, agent: 'market-intelligence', proposals: [{ amount: 5n }] },
      Symbol('x'),
      () => 1,
    ]) {
      const w = makeWorld({
        lending: watch,
        agents: [scriptedAgent('market-intelligence', weird), guardian()],
      });
      const r = await w.orchestrator.runCycle(w.nextKey());
      expect(r.status).toBe('dry_run');
    }
  });

  it('an agent cannot alter what the others see (each gets its own deep copy)', async () => {
    const vandal: ProposalAgent = {
      id: 'market-intelligence',
      async propose(obs) {
        (obs.snapshot.walletBalances as unknown[]).length = 0;
        (obs.snapshot.lending as unknown as { borrowed: unknown[] }).borrowed.length = 0;
        (obs.risk as { level: string }).level = 'healthy';
        return wire('market-intelligence', []);
      },
    };
    const w = makeWorld({ lending: watch, agents: [vandal, guardian()] });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('watch');
    expect(r.status).toBe('dry_run');
    expect(r.decision?.ranked[0]?.action.kind).toBe('lending.repay');
  });

  it('an agent that stalls past the freshness window cannot cause a trade on stale data', async () => {
    const holder: { advance: () => void } = { advance: () => undefined };
    const slow: ProposalAgent = {
      id: 'market-intelligence',
      async propose() {
        holder.advance();
        return wire('market-intelligence', []);
      },
    };
    const w = makeWorld({ lending: watch, agents: [slow, guardian()] });
    holder.advance = () => w.clock.advanceSeconds(300);
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(w.spies.execute).toBe(0);
    expect(w.spies.approve).toBe(0);
  });

  it('a cycle with every agent failing still audits and completes (no action, no crash)', async () => {
    const agents: ProposalAgent[] = (
      ['market-intelligence', 'lp-optimizer', 'liquidation-guardian', 'capital-allocator'] as const
    ).map((id) => ({
      id,
      async propose() {
        throw new Error('down');
      },
    }));
    const w = makeWorld({ lending: watch, agents });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision?.reasons).toEqual(['NOTHING_PROPOSED']);
    // The risk is still reported, because that is computed by the engine and not by any agent.
    expect(w.codes()).toContain('RISK_WATCH');
  });

  it('an agent with several invalid items in one cycle is quarantined; one persistent garbage item is only reported', async () => {
    const bad = { kind: 'allocation.swap', nonsense: true };
    const noisy = makeWorld({
      lending: null,
      agents: [scriptedAgent('capital-allocator', wire('capital-allocator', [bad, bad, bad]))],
    });
    await noisy.orchestrator.runCycle(noisy.nextKey());
    expect(
      (await noisy.orchestrator.controlState()).quarantined['capital-allocator'],
    ).toBeDefined();
    expect(noisy.codes()).toContain('AGENT_QUARANTINED');

    const garbage = makeWorld({
      lending: null,
      agents: [scriptedAgent('capital-allocator', { nonsense: true })],
    });
    for (let i = 0; i < 3; i += 1) await garbage.orchestrator.runCycle(garbage.nextKey());
    // Its output is discarded every time and an operator is told, but one bad envelope is not grounds to quarantine.
    expect(garbage.codes().filter((c) => c === 'AGENT_OUTPUT_INVALID')).toHaveLength(3);
    expect(garbage.events.every((e) => e.severity === 'info')).toBe(true);
    expect(garbage.spies.execute).toBe(0);
  });
});
