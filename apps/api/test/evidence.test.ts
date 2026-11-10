import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from '@near-autopilot/config';
import { accountId } from '@near-autopilot/core';
import { SilentLogger } from '@near-autopilot/core/testing';
import { parseMarketConfig } from '../src/market-config';
import {
  auditHash,
  ChainVerifier,
  GENESIS,
  storedPayload,
  type ChainRow,
} from '../src/evidence/chain';
import { replayVerdict, type StoredVerdict } from '../src/evidence/replay';
import type { PolicyVerdictRecord } from '../src/repository';
import { wire } from '../src/wiring';
import { InMemoryRepository } from './in-memory-repository';

// ------------------------------------------------------------------------------------------------ the hash chain

function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS;
  for (let seq = 1; seq <= n; seq += 1) {
    const e = {
      seq,
      at: new Date(Date.UTC(2026, 10, 5, 12, 0, seq)),
      type: seq % 2 ? 'proposal_approved' : 'execution_dry_run',
      runId: 'run-1',
      proposalId: `p-${seq}`,
      payload: storedPayload({
        n: BigInt(seq) * 10n ** 24n,
        at: new Date(0),
        nested: { b: 1, a: [1, 2] },
      }),
    };
    const hash = auditHash(prev, e);
    rows.push({ ...e, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('audit hash chain', () => {
  it('verifies an intact chain fed in pages, and names its head', () => {
    const rows = chain(25);
    const v = new ChainVerifier();
    for (let i = 0; i < rows.length; i += 10) expect(v.feed(rows.slice(i, i + 10))).toBe(true);
    expect(v.result()).toEqual({ ok: true, entries: 25, head: { seq: 25, hash: rows[24]?.hash } });
  });

  it('the stored payload is what JSON (jsonb) hands back: bigint and Date as text', () => {
    expect(storedPayload({ x: 5n, d: new Date(0), m: new Map([['k', 1n]]) })).toEqual({
      x: '5',
      d: '1970-01-01T00:00:00.000Z',
      m: { k: '1' },
    });
  });

  it.each([
    [
      'an edited payload',
      (r: ChainRow[]) => (r[6] = { ...r[6]!, payload: { n: 'forged' } }),
      7,
      'hash',
    ],
    [
      'an edited type',
      (r: ChainRow[]) => (r[6] = { ...r[6]!, type: 'proposal_rejected' }),
      7,
      'hash',
    ],
    ['a deleted entry', (r: ChainRow[]) => r.splice(6, 1), 8, 'gap'],
    [
      'a re-hashed edit (the next entry no longer links to it)',
      (r: ChainRow[]) => {
        const e = { ...r[6]!, payload: { n: 'forged' } };
        r[6] = { ...e, hash: auditHash(e.prevHash, e) };
      },
      8,
      'prev_hash',
    ],
  ] as const)('detects %s and where', (_name, tamper, seq, kind) => {
    const rows = chain(10);
    tamper(rows);
    const v = new ChainVerifier();
    v.feed(rows);
    const r = v.result();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.brokenAt).toMatchObject({ seq, kind });
    // Entries before the break still verify; nothing after it counts.
    expect(r.entries).toBe(kind === 'prev_hash' ? 7 : 6);
  });
});

// ------------------------------------------------------------------------------------------------ replay

const ACCOUNT = 'your-account.near';
const configFile = 'agents-config.json';
const config = parseMarketConfig(
  JSON.parse(readFileSync(new URL(`./fixtures/${configFile}`, import.meta.url), 'utf8')) as unknown,
  accountId(ACCOUNT),
);

/** Real verdicts: the production composition root on the offline simulation, both engines. */
async function storedVerdicts(engine: string, portfolio: string): Promise<StoredVerdict[]> {
  const repo = new InMemoryRepository({ dataSource: 'simulation', network: 'mainnet' });
  const env = loadApiEnv({
    API_TOKEN: 'test-token-test-token-test-token-test',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AUTOPILOT_ACCOUNT_ID: ACCOUNT,
    NEAR_NETWORK: 'mainnet',
    NEAR_RPC_URL: 'https://rpc.must-not-be-contacted.invalid',
    RHEA_CONTRACT_ID: 'v2.ref-finance.near',
    BURROW_CONTRACT_ID: 'contract.main.burrow.near',
    BURROW_ORACLE_ID: 'priceoracle.near',
    DATA_SOURCE: 'simulation',
    AUTOPILOT_ENGINE: engine,
    SIMULATION_PORTFOLIO: portfolio,
  });
  const fetchImpl: typeof fetch = async () => {
    throw new Error('no network in this test');
  };
  const wired = await wire(env, config, repo, new SilentLogger(), { fetchImpl });
  await wired.cycle.run();
  // Exactly what Postgres stores and returns: a JSON round trip of the row, the valuation as text.
  return repo.verdicts.map((v: PolicyVerdictRecord) => ({
    id: v.id,
    evaluatedAt: v.evaluatedAt,
    verdict: v.verdict,
    outcome: v.outcome,
    policyVersion: v.policyVersion,
    snapshotId: v.snapshotId,
    planHash: v.planHash,
    valueUsdMicro: v.valueUsdMicro === null ? null : v.valueUsdMicro.toString(),
    checks: JSON.parse(JSON.stringify(v.checks)) as unknown,
    violations: JSON.parse(JSON.stringify(v.violations)) as unknown,
    input: JSON.parse(JSON.stringify(v.input)) as unknown,
  }));
}

describe.each(['legacy', 'orchestrator'])('replay of stored verdicts, %s engine', (engine) => {
  it('ALLOW (demo-500) and BLOCK (demo-5000) replay to the same verdict from the row alone', async () => {
    const rows = [
      ...(await storedVerdicts(engine, 'demo-500')),
      ...(await storedVerdicts(engine, 'demo-5000')),
    ];
    expect(new Set(rows.map((r) => r.verdict))).toEqual(new Set(['ALLOW', 'BLOCK']));
    for (const r of rows)
      expect(replayVerdict(r)).toEqual({
        id: r.id,
        status: 'match',
        verdict: r.verdict,
        configFrom: 'row',
      });
  });

  it('detects a stored verdict that was altered, an altered snapshot, plan or config', async () => {
    const [row] = await storedVerdicts(engine, 'demo-500');
    if (!row) throw new Error('no verdict');
    const input = row.input as {
      snapshot: { nativeBalance: string };
      plan: { receiverId: string };
      config: { cooldownSeconds: number };
    };
    expect(replayVerdict({ ...row, verdict: 'BLOCK', outcome: 'reject' })).toMatchObject({
      status: 'mismatch',
      stage: 'verdict',
    });
    const snapshot = { ...input, snapshot: { ...input.snapshot, nativeBalance: '1' } };
    expect(replayVerdict({ ...row, input: snapshot })).toMatchObject({ stage: 'snapshot_id' });
    const plan = { ...input, plan: { ...input.plan, receiverId: 'evil.near' } };
    expect(replayVerdict({ ...row, input: plan })).toMatchObject({ stage: 'plan_hash' });
    const cfg = {
      ...input,
      config: { ...input.config, cooldownSeconds: input.config.cooldownSeconds + 1 },
    };
    expect(replayVerdict({ ...row, input: cfg })).toMatchObject({ stage: 'config' });
  });

  it('a row stored without its config replays only with a supplied config of the same version', async () => {
    const [row] = await storedVerdicts(engine, 'demo-500');
    if (!row) throw new Error('no verdict');
    const { config: _dropped, ...withoutConfig } = row.input as Record<string, unknown>;
    const old = { ...row, input: withoutConfig };
    expect(replayVerdict(old)).toMatchObject({ status: 'not_replayable' });
    expect(replayVerdict(old, [{ ...config.policy, maxActionUsd: 99 }])).toMatchObject({
      status: 'not_replayable',
    });
    expect(replayVerdict(old, [config.policy])).toMatchObject({
      status: 'match',
      configFrom: 'file',
    });
  });
});
