import { describe, expect, it } from 'vitest';
import {
  AGENT_CAPABILITIES,
  AGENT_IDS,
  RISK_RANK,
  decide,
  parseAgentOutput,
  type AgentId,
  type EvaluationInput,
  type Mode,
  type ParsedProposal,
  type QuoteInput,
} from '../../src';
import { NOW, USDT, WNEAR, makeWorld, near, usdt } from '../support/world';
import { buildInput, prop } from '../support/inputs';
import { int, mulberry32, pick, shuffle } from '../support/prng';

const RUNS = 250;
type Rnd = () => number;

/* ------------------------------ generators ------------------------------ */

function genWorld(rnd: Rnd) {
  const borrowing = rnd() < 0.8;
  return makeWorld({
    lending: borrowing ? { collateralNear: int(rnd, 20, 200), debtUsdt: int(rnd, 10, 340) } : null,
    wallet: {
      near: rnd() < 0.15 ? 0 : int(rnd, 0, 300),
      usdt: rnd() < 0.15 ? 0 : int(rnd, 0, 2000),
    },
    yields: { near: int(rnd, 0, 60), usdt: int(rnd, 0, 60) },
  });
}

const genAmount = (rnd: Rnd, unit: 'near' | 'usdt'): bigint => {
  const n = pick(rnd, [1, 5, 10, 30, 100, 400, 100_000]);
  return unit === 'near' ? near(n) : usdt(n);
};

function genProposals(rnd: Rnd, withSignals = true): ParsedProposal[] {
  const out: ParsedProposal[] = [];
  const n = int(rnd, 0, 6);
  for (let i = 0; i < n; i += 1) {
    switch (int(rnd, 0, withSignals ? 5 : 4)) {
      case 0:
        out.push(
          prop('liquidation-guardian', {
            kind: 'lending.repay',
            token: USDT,
            amount: genAmount(rnd, 'usdt'),
            rationale: `r${i}`,
          }),
        );
        break;
      case 1:
        out.push(
          prop('liquidation-guardian', {
            kind: 'lending.supply_collateral',
            token: pick(rnd, [WNEAR, USDT]),
            amount: genAmount(rnd, 'near'),
            rationale: `s${i}`,
          }),
        );
        break;
      case 2:
      case 3: {
        const buy = pick(rnd, [WNEAR, USDT]);
        const sell = rnd() < 0.1 ? buy : buy === WNEAR ? USDT : WNEAR;
        out.push(
          prop('capital-allocator', {
            kind: 'allocation.swap',
            tokenIn: sell,
            tokenOut: buy,
            amountIn: genAmount(rnd, sell === WNEAR ? 'near' : 'usdt'),
            maxSlippageBps: pick(rnd, [10, 50, 100, 500]),
            rationale: `w${i}`,
          }),
        );
        break;
      }
      case 4:
        out.push(
          prop('capital-allocator', { kind: 'no_action', reasonCode: 'no_edge', rationale: 'n' }),
        );
        break;
      default:
        out.push(
          prop('market-intelligence', {
            kind: 'market.signal',
            token: pick(rnd, [WNEAR, USDT]),
            signal: pick(rnd, ['volatility_spike', 'depeg_risk']),
            severity: int(rnd, 1, 5),
            validUntil: new Date(NOW.getTime() + int(rnd, -60, 600) * 1000),
            rationale: 'sig',
          }),
        );
    }
  }
  return out;
}

/** Fair-ish quotes (about 30 bps below oracle), with some routes missing. Identical for identical proposals. */
function genQuotes(rnd: Rnd, proposals: ParsedProposal[]): Map<string, QuoteInput | null> {
  const quotes = new Map<string, QuoteInput | null>();
  for (const p of proposals) {
    const x = p.proposal;
    if (x.kind !== 'allocation.swap') continue;
    if (rnd() < 0.1) {
      quotes.set(p.proposalId, null);
      continue;
    }
    const usdValue =
      x.tokenIn === WNEAR ? (Number(x.amountIn / 10n ** 18n) / 1e6) * 5 : Number(x.amountIn) / 1e6; // coarse, only for generating a plausible quote
    const out = x.tokenOut === USDT ? usdt(usdValue * 0.997) : near((usdValue / 5) * 0.997);
    quotes.set(p.proposalId, { poolId: 7, amountIn: x.amountIn, amountOut: out > 0n ? out : 1n });
  }
  return quotes;
}

function genInput(rnd: Rnd, opts: { signals?: boolean } = {}): EvaluationInput {
  const world = genWorld(rnd);
  const proposals = genProposals(rnd, opts.signals ?? true);
  const mode = pick<Mode>(rnd, ['normal', 'normal', 'normal', 'risk_reduction_only', 'read_only']);
  return buildInput(proposals, world, { persistedMode: mode, quotes: genQuotes(rnd, proposals) });
}

const walletOf = (i: EvaluationInput, token: string): bigint =>
  i.snapshot.walletBalances.find((b) => b.token === token)?.raw ?? 0n;
const forAll = (seed: number, body: (rnd: Rnd, run: number) => void) => {
  const rnd = mulberry32(seed);
  for (let run = 0; run < RUNS; run += 1) body(rnd, run);
};

/* ------------------------------ properties ------------------------------ */

describe('properties of decide()', () => {
  it('never throws, and "act" holds exactly when something executable was ranked', () => {
    forAll(1, (rnd) => {
      const d = decide(genInput(rnd));
      expect(d.outcome === 'act').toBe(d.ranked.length > 0);
      expect(d.outcome === 'act' ? d.reasons.length === 0 : d.reasons.length > 0).toBe(true);
    });
  });

  it('no candidate spends more than the wallet holds', () => {
    forAll(2, (rnd) => {
      const input = genInput(rnd);
      for (const c of decide(input).ranked) {
        const a = c.action;
        const spent =
          a.kind === 'allocation.swap'
            ? { token: a.tokenIn, amount: a.amountIn }
            : { token: a.token, amount: a.amount };
        expect(spent.amount > 0n && spent.amount <= walletOf(input, spent.token)).toBe(true);
      }
    });
  });

  it('no swap exceeds the configured size limit or slippage cap, and none is ranked at watch-or-worse or outside normal mode', () => {
    forAll(3, (rnd) => {
      const input = genInput(rnd);
      const d = decide(input);
      for (const c of d.ranked) {
        if (c.action.kind !== 'allocation.swap') continue;
        expect(
          c.economics!.valueInUsdMicro <= BigInt(Math.round(input.config.swap.maxSwapUsd * 1e6)),
        ).toBe(true);
        expect(c.action.slippageBps <= input.config.swap.maxSlippageBps).toBe(true);
        expect(c.action.minAmountOut <= c.action.quotedAmountOut).toBe(true);
        expect(RISK_RANK[d.risk.level] < RISK_RANK.watch).toBe(true);
        expect(d.mode.effective).toBe('normal');
        expect(c.tier).toBe(2);
      }
    });
  });

  it('every risk-reducing candidate strictly improves the health factor and never repays more than is owed', () => {
    forAll(4, (rnd) => {
      const input = genInput(rnd);
      const owed = input.snapshot.lending?.borrowed.find((b) => b.token === USDT)?.raw ?? 0n;
      for (const c of decide(input).ranked) {
        if (c.action.kind === 'allocation.swap') continue;
        expect(
          c.riskEffect!.hfAfterWad === null ||
            c.riskEffect!.hfBeforeWad === null ||
            c.riskEffect!.hfAfterWad > c.riskEffect!.hfBeforeWad,
        ).toBe(true);
        expect(c.sizing.final <= c.sizing.requested).toBe(true);
        if (c.action.kind === 'lending.repay') expect(c.action.amount <= owed).toBe(true);
        expect(c.basis).toBe('risk_reduction');
      }
    });
  });

  it('read-only mode, or blocking data, never yields an executable candidate', () => {
    forAll(5, (rnd) => {
      const input = genInput(rnd);
      const ro = decide({ ...input, persistedMode: 'read_only' });
      expect(ro.outcome).toBe('no_action');
      expect(ro.ranked).toHaveLength(0);
      const blocked = decide({
        ...input,
        dataQuality: {
          ...input.dataQuality,
          blocking: true,
          issues: [{ code: 'SNAPSHOT_STALE', blocking: true, detail: 'x' }],
        },
      });
      expect(blocked.outcome).toBe('no_action');
      expect(blocked.ranked).toHaveLength(0);
      expect(blocked.reasons).toEqual(['DATA_NOT_FRESH']);
    });
  });

  it('the order proposals arrive in changes nothing, including the decision id', () => {
    forAll(6, (rnd) => {
      const input = genInput(rnd);
      const a = decide(input);
      const b = decide({ ...input, proposals: shuffle(rnd, input.proposals) });
      expect(b.decisionId).toBe(a.decisionId);
      expect(b.ranked.map((c) => c.proposalId)).toEqual(a.ranked.map((c) => c.proposalId));
    });
  });

  it('market signals can only remove candidates, never add them', () => {
    forAll(7, (rnd) => {
      const withoutSignals = genInput(rnd, { signals: false });
      const base = decide(withoutSignals);
      const sigs = Array.from({ length: int(rnd, 1, 4) }, () =>
        prop('market-intelligence', {
          kind: 'market.signal',
          token: pick(rnd, [WNEAR, USDT]),
          signal: 'volatility_spike',
          severity: int(rnd, 1, 5),
          validUntil: new Date(NOW.getTime() + 60_000),
          rationale: String(rnd()),
        }),
      );
      const withSignals = decide({
        ...withoutSignals,
        proposals: [...withoutSignals.proposals, ...sigs],
      });
      const before = new Set(base.ranked.map((c) => c.proposalId));
      for (const c of withSignals.ranked) expect(before.has(c.proposalId)).toBe(true);
    });
  });

  it('quarantining an agent that does not supply signals can only remove candidates', () => {
    forAll(8, (rnd) => {
      const input = genInput(rnd);
      const base = new Set(decide(input).ranked.map((c) => c.proposalId));
      const agent = pick<AgentId>(rnd, [
        'lp-optimizer',
        'liquidation-guardian',
        'capital-allocator',
      ]);
      const after = decide({ ...input, quarantined: new Set([agent]) });
      for (const c of after.ranked) {
        expect(base.has(c.proposalId)).toBe(true);
        expect(c.agent).not.toBe(agent);
      }
    });
  });

  it('a tighter mode can only remove candidates (normal >= risk_reduction_only >= read_only)', () => {
    forAll(9, (rnd) => {
      const input = genInput(rnd);
      const ids = (m: Mode) =>
        new Set(decide({ ...input, persistedMode: m }).ranked.map((c) => c.proposalId));
      const [n, r, o] = [ids('normal'), ids('risk_reduction_only'), ids('read_only')];
      for (const id of r) expect(n.has(id)).toBe(true);
      for (const id of o) expect(r.has(id)).toBe(true);
    });
  });

  it('ranking is by tier first, and every discretionary candidate comes after every risk reduction', () => {
    forAll(10, (rnd) => {
      const d = decide(genInput(rnd));
      const tiers = d.ranked.map((c) => c.tier);
      expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    });
  });

  it('decisions are deterministic and the input is not mutated', () => {
    forAll(11, (rnd) => {
      const input = genInput(rnd);
      const snapshotBefore = JSON.stringify(input.proposals.map((p) => p.proposalId));
      const a = decide(input);
      const b = decide(input);
      expect(a.decisionId).toBe(b.decisionId);
      expect(a.inputsHash).toBe(b.inputsHash);
      expect(JSON.stringify(input.proposals.map((p) => p.proposalId))).toBe(snapshotBefore);
    });
  });

  it('more debt never turns a no-risk situation into a lower risk level', () => {
    forAll(12, (rnd) => {
      const collateralNear = int(rnd, 40, 200);
      let worst = -1;
      for (let debt = 20; debt <= 340; debt += 20) {
        const w = makeWorld({ lending: { collateralNear, debtUsdt: debt } });
        const d = decide(buildInput([], w));
        const rank = RISK_RANK[d.risk.level];
        expect(rank >= worst).toBe(true);
        worst = rank;
      }
    });
  });
});

describe('properties of parseAgentOutput', () => {
  const genJson = (rnd: Rnd, depth = 0): unknown => {
    const kinds = depth > 3 ? 5 : 7;
    switch (int(rnd, 0, kinds)) {
      case 0:
        return null;
      case 1:
        return rnd() < 0.5;
      case 2:
        return int(rnd, -1e6, 1e6);
      case 3:
        return pick(rnd, [
          '',
          'x',
          '0',
          '-1',
          '99999999999999999999999999999999999999999',
          'lending.repay',
          'receiverId',
          usdt(1).toString(),
        ]);
      case 4:
        return pick(rnd, [USDT, WNEAR, 'a.near']);
      case 5:
        return Array.from({ length: int(rnd, 0, 3) }, () => genJson(rnd, depth + 1));
      default: {
        const o: Record<string, unknown> = {};
        for (let i = int(rnd, 0, 5); i > 0; i -= 1)
          o[
            pick(rnd, [
              'kind',
              'token',
              'amount',
              'agent',
              'proposals',
              'schemaVersion',
              'asOf',
              'rationale',
              'receiverId',
              'tokenIn',
              'tokenOut',
              'amountIn',
              'maxSlippageBps',
              'x',
            ])
          ] = genJson(rnd, depth + 1);
        return o;
      }
    }
  };

  it('never throws and never returns a kind outside the agent’s capabilities, for arbitrary JSON', () => {
    forAll(20, (rnd) => {
      const raw = genJson(rnd);
      for (const agent of AGENT_IDS) {
        for (const input of [raw, JSON.stringify(raw)]) {
          const r = parseAgentOutput(agent, input);
          for (const p of r.proposals) expect(AGENT_CAPABILITIES[agent]).toContain(p.proposal.kind);
        }
      }
    });
  });

  it('structurally plausible but mutated envelopes: still never throws, never exceeds capabilities, amounts are always positive bigints', () => {
    const kinds = [
      'no_action',
      'market.signal',
      'lp.reposition',
      'lending.repay',
      'lending.supply_collateral',
      'allocation.swap',
      'bogus',
    ];
    forAll(21, (rnd) => {
      const proposals = Array.from({ length: int(rnd, 0, 10) }, () => ({
        kind: pick(rnd, kinds),
        token: pick(rnd, [USDT, WNEAR, 'x']),
        tokenIn: pick(rnd, [USDT, WNEAR]),
        tokenOut: pick(rnd, [USDT, WNEAR]),
        amount: genJson(rnd, 3),
        amountIn: genJson(rnd, 3),
        maxSlippageBps: genJson(rnd, 3),
        rationale: pick(rnd, ['ok', 'x'.repeat(int(rnd, 0, 700))]),
        reasonCode: pick(rnd, ['healthy', 'other', 'nope']),
        positionId: 'p',
        tickLower: genJson(rnd, 3),
        tickUpper: genJson(rnd, 3),
        signal: pick(rnd, ['volatility_spike', 'x']),
        severity: genJson(rnd, 3),
        validUntil: pick(rnd, [NOW.toISOString(), 'x']),
      }));
      const agent = pick<AgentId>(rnd, [...AGENT_IDS]);
      const r = parseAgentOutput(agent, {
        schemaVersion: 1,
        agent: rnd() < 0.9 ? agent : pick(rnd, [...AGENT_IDS]),
        asOf: NOW.toISOString(),
        proposals,
      });
      for (const p of r.proposals) {
        expect(AGENT_CAPABILITIES[agent]).toContain(p.proposal.kind);
        const x = p.proposal as { amount?: bigint; amountIn?: bigint };
        if (x.amount !== undefined)
          expect(typeof x.amount === 'bigint' && x.amount > 0n).toBe(true);
        if (x.amountIn !== undefined)
          expect(typeof x.amountIn === 'bigint' && x.amountIn > 0n).toBe(true);
      }
    });
  });

  it('any forbidden key anywhere makes the output suspicious and yields no proposals', () => {
    const keys = [
      'receiverId',
      'privateKey',
      'methodName',
      'args',
      'signature',
      'policyOverride',
      'actions',
      'nonce',
    ];
    forAll(22, (rnd) => {
      const good = { kind: 'lending.repay', token: USDT, amount: '5', rationale: 'r' };
      let target: Record<string, unknown> = { ...good };
      const root = {
        schemaVersion: 1,
        agent: 'liquidation-guardian',
        asOf: NOW.toISOString(),
        proposals: [target],
      } as Record<string, unknown>;
      // Bury a forbidden key at a random depth inside the proposal.
      for (let d = int(rnd, 0, 4); d > 0; d -= 1) {
        const next: Record<string, unknown> = {};
        target[pick(rnd, ['meta', 'extra', 'x'])] = next;
        target = next;
      }
      target[pick(rnd, keys)] = 'x';
      const r = parseAgentOutput('liquidation-guardian', root);
      expect(r.suspicious).toBe(true);
      expect(r.proposals).toHaveLength(0);
    });
  });
});
