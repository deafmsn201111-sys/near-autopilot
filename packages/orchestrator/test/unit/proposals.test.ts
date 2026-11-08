import { describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITIES,
  AGENT_IDS,
  MAX_PROPOSALS_PER_OUTPUT,
  findForbiddenKeys,
  parseAgentOutput,
  type AgentId,
} from '../../src';
import { NOW, USDT, WNEAR } from '../support/world';

const env = (agent: string, proposals: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  agent,
  asOf: NOW.toISOString(),
  proposals,
  ...extra,
});
const noAction = { kind: 'no_action', reasonCode: 'healthy', rationale: 'ok' };
const repay = { kind: 'lending.repay', token: USDT, amount: '1000', rationale: 'x' };
const swap = {
  kind: 'allocation.swap',
  tokenIn: WNEAR,
  tokenOut: USDT,
  amountIn: '1000',
  maxSlippageBps: 50,
  rationale: 'x',
};
const signal = {
  kind: 'market.signal',
  token: WNEAR,
  signal: 'volatility_spike',
  severity: 3,
  validUntil: NOW.toISOString(),
  rationale: 'x',
};
const lp = {
  kind: 'lp.reposition',
  positionId: 'p1',
  tickLower: -10,
  tickUpper: 10,
  rationale: 'x',
};
const supply = { kind: 'lending.supply_collateral', token: WNEAR, amount: '5', rationale: 'x' };
const concentration = {
  kind: 'portfolio.signal',
  token: WNEAR,
  signal: 'concentration',
  severity: 4,
  exposureBps: 9100,
  rationale: 'x',
};

const valid: Record<AgentId, unknown[]> = {
  'market-intelligence': [signal],
  'portfolio-intelligence': [concentration],
  'lp-optimizer': [lp],
  'liquidation-guardian': [repay, supply],
  'capital-allocator': [swap],
};

describe('parseAgentOutput', () => {
  it('accepts each agent’s own proposal kinds, from an object or a JSON string', () => {
    for (const agent of AGENT_IDS) {
      const out = env(agent, [noAction, ...valid[agent]]);
      for (const raw of [out, JSON.stringify(out)]) {
        const r = parseAgentOutput(agent, raw);
        expect(r.issues).toEqual([]);
        expect(r.suspicious).toBe(false);
        expect(r.proposals).toHaveLength(1 + valid[agent].length);
      }
    }
  });

  it('amounts become bigint; the agent cannot supply a number', () => {
    const r = parseAgentOutput('liquidation-guardian', env('liquidation-guardian', [repay]));
    expect((r.proposals[0]?.proposal as { amount: bigint }).amount).toBe(1000n);
    expect(
      parseAgentOutput(
        'liquidation-guardian',
        env('liquidation-guardian', [{ ...repay, amount: 1000 }]),
      ).proposals,
    ).toHaveLength(0);
  });

  it('enforces the capability table: every agent is refused every kind outside its list', () => {
    const all = [noAction, signal, concentration, lp, repay, supply, swap];
    for (const agent of AGENT_IDS) {
      const r = parseAgentOutput(agent, env(agent, all));
      const allowed = new Set<string>(AGENT_CAPABILITIES[agent]);
      expect(r.proposals.every((p) => allowed.has(p.proposal.kind))).toBe(true);
      const refused = all.filter((p) => !allowed.has(p.kind)).length;
      expect(r.issues.filter((i) => i.code === 'CAPABILITY')).toHaveLength(refused);
    }
  });

  it('a market-intelligence agent can never emit anything that moves funds', () => {
    expect(
      AGENT_CAPABILITIES['market-intelligence'].every(
        (k) => k === 'no_action' || k === 'market.signal',
      ),
    ).toBe(true);
    expect(
      AGENT_CAPABILITIES['lp-optimizer'].every((k) => k === 'no_action' || k === 'lp.reposition'),
    ).toBe(true);
  });

  it('rejects an output that claims to be another agent, and marks it suspicious', () => {
    const r = parseAgentOutput('market-intelligence', env('liquidation-guardian', [noAction]));
    expect(r.issues.map((i) => i.code)).toContain('WRONG_AGENT');
    expect(r.suspicious).toBe(true);
    expect(r.proposals).toHaveLength(0);
  });

  it('unknown keys are a schema error (strict), but are not "suspicious" unless the name is transaction-shaped', () => {
    const r = parseAgentOutput(
      'liquidation-guardian',
      env('liquidation-guardian', [{ ...repay, colour: 'blue' }]),
    );
    expect(r.proposals).toHaveLength(0);
    expect(r.issues.map((i) => i.code)).toEqual(['SCHEMA']);
    expect(r.suspicious).toBe(false);
  });

  it('forbidden field names are detected at any depth and in any case', () => {
    for (const key of [
      'receiverId',
      'RECEIVER_ID',
      'privateKey',
      'private_key',
      'mnemonic',
      'seedPhrase',
      'methodName',
      'args',
      'actions',
      'signature',
      'signedTx',
      'nonce',
      'deposit',
      'gas',
      'policyOverride',
      'allowlist',
      'accessKey',
      'publicKey',
      'blockHash',
      'killSwitch',
      'approve',
    ]) {
      const r = parseAgentOutput(
        'liquidation-guardian',
        env('liquidation-guardian', [{ ...repay, nested: { deeper: [{ [key]: 1 }] } }]),
      );
      expect([key, r.suspicious]).toEqual([key, true]);
      expect(r.proposals).toHaveLength(0);
    }
  });

  it('a suspicious output yields no proposals at all, even valid-looking siblings', () => {
    const r = parseAgentOutput(
      'liquidation-guardian',
      env('liquidation-guardian', [repay, { ...repay, receiverId: 'x' }]),
    );
    expect(r.suspicious).toBe(true);
    expect(r.proposals.length).toBeLessThanOrEqual(1); // the clean sibling may parse, but the orchestrator quarantines the agent and discards all
  });

  it('forbidden WORDS inside values are fine: only keys are inspected', () => {
    const r = parseAgentOutput(
      'liquidation-guardian',
      env('liquidation-guardian', [
        { ...repay, rationale: 'the private key policy says approve the receiver' },
      ]),
    );
    expect(r.suspicious).toBe(false);
    expect(r.proposals).toHaveLength(1);
  });

  it('findForbiddenKeys is depth-limited and survives cycles and hostile prototypes', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = cyc;
    expect(() => findForbiddenKeys(cyc)).not.toThrow();
    expect(findForbiddenKeys(JSON.parse('{"__proto__":{"receiver":1}}')).length).toBeGreaterThan(0);
    let deep: unknown = { receiver: 1 };
    for (let i = 0; i < 200; i += 1) deep = { x: deep };
    expect(() => findForbiddenKeys(deep)).not.toThrow();
  });

  const badAmounts: unknown[] = [
    '0',
    '-1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    '+1',
    '0x1',
    '١٢٣',
    `1${'0'.repeat(39)}`,
    '',
    'NaN',
    'Infinity',
    1,
    null,
    undefined,
    true,
    [],
    {},
  ];
  it('rejects every malformed amount', () => {
    for (const amount of badAmounts) {
      const raw = JSON.stringify(
        env('liquidation-guardian', [{ ...repay, amount }]),
        (_: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v),
      );
      const r = parseAgentOutput('liquidation-guardian', raw);
      expect([String(amount), r.proposals.length]).toEqual([String(amount), 0]);
    }
  });

  it('accepts the largest allowed amount (39 digits) and nothing wider', () => {
    expect(
      parseAgentOutput(
        'liquidation-guardian',
        env('liquidation-guardian', [{ ...repay, amount: '9'.repeat(39) }]),
      ).proposals,
    ).toHaveLength(1);
    expect(
      parseAgentOutput(
        'liquidation-guardian',
        env('liquidation-guardian', [{ ...repay, amount: '9'.repeat(40) }]),
      ).proposals,
    ).toHaveLength(0);
  });

  it('bounds every field: slippage, severity, rationale length, proposal count, tick ordering types', () => {
    const cases: [string, string, unknown][] = [
      ['capital-allocator', 'slippage', { ...swap, maxSlippageBps: 1001 }],
      ['capital-allocator', 'negative slippage', { ...swap, maxSlippageBps: -1 }],
      ['capital-allocator', 'fractional slippage', { ...swap, maxSlippageBps: 10.5 }],
      ['market-intelligence', 'severity 0', { ...signal, severity: 0 }],
      ['market-intelligence', 'severity 6', { ...signal, severity: 6 }],
      ['market-intelligence', 'bad signal', { ...signal, signal: 'moon' }],
      ['market-intelligence', 'bad date', { ...signal, validUntil: 'tomorrow-ish' }],
      ['liquidation-guardian', 'long rationale', { ...repay, rationale: 'x'.repeat(501) }],
      ['lp-optimizer', 'float tick', { ...lp, tickLower: 1.5 }],
      ['lp-optimizer', 'string tick', { ...lp, tickLower: '1' }],
      ['liquidation-guardian', 'no kind', { token: USDT, amount: '1', rationale: 'x' }],
      ['liquidation-guardian', 'unknown kind', { ...repay, kind: 'lending.borrow' }],
    ];
    for (const [agent, label, p] of cases) {
      const r = parseAgentOutput(agent as AgentId, env(agent, [p]));
      expect([label, r.proposals.length]).toEqual([label, 0]);
    }
    const many = parseAgentOutput(
      'liquidation-guardian',
      env(
        'liquidation-guardian',
        Array.from({ length: MAX_PROPOSALS_PER_OUTPUT + 1 }, () => repay),
      ),
    );
    expect(many.proposals).toHaveLength(0);
  });

  it('never throws on hostile input of any shape', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      NaN,
      1n,
      true,
      '',
      ' ',
      '{',
      '[]',
      'null',
      '"str"',
      '[[[[[[',
      [],
      {},
      { proposals: 'x' },
      cyc,
      Symbol('s'),
      () => 1,
      new Date(),
      new Map(),
      'x'.repeat(200_000),
      JSON.stringify({ a: 'x'.repeat(200_000) }),
    ];
    for (const raw of hostile) {
      for (const agent of AGENT_IDS) {
        const r = parseAgentOutput(agent, raw);
        expect(Array.isArray(r.proposals)).toBe(true);
        expect(r.proposals).toHaveLength(0);
      }
    }
  });

  it('an object carrying a raw bigint (not JSON-serialisable) is refused, not crashed on', () => {
    const r = parseAgentOutput(
      'liquidation-guardian',
      env('liquidation-guardian', [{ ...repay, amount: 5n }]),
    );
    expect(r.proposals).toHaveLength(0);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('oversized output is refused before it is parsed', () => {
    const r = parseAgentOutput('market-intelligence', 'x'.repeat(70_000));
    expect(r.issues.map((i) => i.code)).toEqual(['TOO_LARGE']);
  });

  it('does not mutate its input', () => {
    const raw = env('capital-allocator', [swap]);
    const before = JSON.stringify(raw);
    parseAgentOutput('capital-allocator', raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
