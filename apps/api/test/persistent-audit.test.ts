import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '@near-autopilot/orchestrator';
import type { AuditEvent } from '../src/repository';
import { PersistentAuditLog } from '../src/services/persistent-audit';

const entry = {
  at: new Date('2026-11-04T12:00:00Z'),
  type: 'agent.output',
  cycleKey: 'cycle-1',
  decisionId: null,
  payload: { agent: 'market-intelligence', reasonCode: 'healthy' },
};

describe('PersistentAuditLog', () => {
  it('writes every orchestrator entry through to the repository, with its chain hash and provenance', async () => {
    const written: AuditEvent[] = [];
    const log = new PersistentAuditLog(
      new InMemoryAuditLog(),
      { appendAudit: async (e) => void written.push(e) },
      { dataSource: 'chain', network: 'mainnet' },
    );
    const a = await log.append(entry);
    await log.append({ ...entry, type: 'cycle.completed' });
    expect(written.map((w) => w.type)).toEqual([
      'orchestrator.agent.output',
      'orchestrator.cycle.completed',
    ]);
    expect(written[0]).toMatchObject({
      runId: 'cycle-1',
      payload: {
        agent: 'market-intelligence',
        seq: a.seq,
        hash: a.hash,
        network: 'mainnet',
        dataSource: 'chain',
      },
    });
    expect(await log.verify()).toEqual({ ok: true });
    expect(await log.entries()).toHaveLength(2);
  });

  it('fails closed: if the database write fails, append throws (the orchestrator then executes nothing)', async () => {
    const log = new PersistentAuditLog(
      new InMemoryAuditLog(),
      {
        appendAudit: async () => {
          throw new Error('db down');
        },
      },
      { dataSource: 'chain', network: 'mainnet' },
    );
    await expect(log.append(entry)).rejects.toThrow('db down');
  });
});
