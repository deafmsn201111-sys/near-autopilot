import { describe, expect, it } from 'vitest';
import type { AssetBalance, PortfolioSnapshot } from '@near-autopilot/core';
import { PortfolioIntelligenceAgent, assessRisk, parseAgentOutput } from '../../src';
import type { AgentObservation } from '../../src';
import {
  ALICE,
  NEAR_PRICE,
  NOW,
  RISK,
  USDT,
  USDT_PRICE,
  WNEAR,
  makeWorld,
  near,
  usdt,
} from '../support/world';

const w = makeWorld();

const snap = (
  walletBalances: AssetBalance[],
  lending: PortfolioSnapshot['lending'] = null,
): PortfolioSnapshot => ({
  accountId: ALICE,
  takenAt: NOW,
  pricesAsOf: NOW,
  nativeBalance: 0n,
  walletBalances,
  lending,
  prices: new Map([
    [WNEAR, NEAR_PRICE], // $5
    [USDT, USDT_PRICE], // $1
  ]),
  risk: RISK,
  tokens: new Map(),
});

const observe = (s: PortfolioSnapshot): AgentObservation => ({
  now: NOW,
  accountId: ALICE,
  snapshot: s,
  market: null,
  risk: assessRisk(s, w.config),
  config: w.config,
});

const run = async (s: PortfolioSnapshot) =>
  parseAgentOutput(
    'portfolio-intelligence',
    JSON.stringify(await new PortfolioIntelligenceAgent().propose(observe(s))),
  );

describe('PortfolioIntelligenceAgent', () => {
  it('raises a concentration signal when one asset dominates gross assets', async () => {
    // 182 NEAR * $5 = $910, plus $90 USDT = $1000 total -> 91% in WNEAR -> severity 4.
    const r = await run(
      snap([
        { token: WNEAR, raw: near(182) },
        { token: USDT, raw: usdt(90) },
      ]),
    );
    expect(r.issues).toEqual([]);
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0]?.proposal;
    expect(p?.kind).toBe('portfolio.signal');
    if (p?.kind === 'portfolio.signal') {
      expect(p.token).toBe(WNEAR);
      expect(p.signal).toBe('concentration');
      expect(p.severity).toBe(4);
      expect(p.exposureBps).toBe(9100);
    }
  });

  it('scales severity to 5 when a single asset is >=95% of assets', async () => {
    const r = await run(
      snap([
        { token: WNEAR, raw: near(190) }, // $950
        { token: USDT, raw: usdt(50) }, // $50 -> 95%
      ]),
    );
    const p = r.proposals[0]?.proposal;
    expect(p?.kind === 'portfolio.signal' && p.severity).toBe(5);
  });

  it('counts Burrow collateral and supplied balances, not borrowed debt', async () => {
    // All exposure is WNEAR collateral; the USDT borrow is debt and must not dilute the concentration.
    const r = await run(
      snap([], {
        protocol: 'burrow',
        accountId: ALICE,
        supplied: [],
        collateral: [{ token: WNEAR, raw: near(100) }],
        borrowed: [{ token: USDT, raw: usdt(400) }],
      }),
    );
    const p = r.proposals[0]?.proposal;
    expect(p?.kind).toBe('portfolio.signal');
    if (p?.kind === 'portfolio.signal') {
      expect(p.token).toBe(WNEAR);
      expect(p.exposureBps).toBe(10_000); // 100% of ASSETS is WNEAR; the debt is excluded
    }
  });

  it('stays quiet (no_action) when no single asset dominates', async () => {
    const r = await run(
      snap([
        { token: WNEAR, raw: near(100) }, // $500
        { token: USDT, raw: usdt(500) }, // $500 -> 50/50
      ]),
    );
    const p = r.proposals[0]?.proposal;
    expect(p?.kind).toBe('no_action');
    if (p?.kind === 'no_action') expect(p.reasonCode).toBe('healthy');
  });

  it('reports insufficient_data for an empty portfolio', async () => {
    const r = await run(snap([]));
    const p = r.proposals[0]?.proposal;
    expect(p?.kind).toBe('no_action');
    if (p?.kind === 'no_action') expect(p.reasonCode).toBe('insufficient_data');
  });
});
