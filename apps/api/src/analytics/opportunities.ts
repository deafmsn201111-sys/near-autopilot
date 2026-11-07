import { loopFor, type LoopMarket } from './looping';
/**
 * ONE RANKING of the DeFi opportunities the collector observed: Rhea liquidity provision and Burrow supply. Pure: it
 * reads stored rows (pools, markets, the latest demo-portfolio analyses) and returns a ranked, explained list.
 *
 * The rank is NOT the APR. Each opportunity gets three scores (0-100):
 *   risk        liquidity depth, price confidence, market structure (impermanent loss or utilisation), history
 *   confidence  how much the numbers can be trusted: price quality, APR window length, a stored simulation, freshness
 *   score       0.45 x yield (capped at 40 % APR, so an outlier cannot dominate) + 0.35 x (100 - risk)
 *               + 0.20 x confidence; halved below $50k liquidity
 * so a high APR on thin liquidity cannot take first place. The weights are display heuristics for ordering, not a
 * forecast and not a policy input: nothing here can approve or execute anything. Net yield is shown only where the
 * collector stored a simulation that includes costs; otherwise it is null ("not simulated"), never estimated here.
 */

export interface PoolInput {
  readonly poolKey: string;
  readonly family: string;
  readonly poolType: string;
  readonly tokens: readonly string[];
  readonly feeBps: number | null;
  readonly tvlUsd: string | null;
  readonly priceQuality: string;
  readonly category: string;
  readonly active: boolean;
  readonly lastSeenAt: Date;
  readonly latest: unknown;
}

export interface MarketInput {
  readonly token: string;
  readonly lastSeenAt: Date;
  readonly latest: unknown;
}

export interface SimulationInput {
  readonly portfolioId: string;
  readonly capitalUsd: number | null;
  readonly lp: readonly {
    poolKey: string;
    status: string;
    netReturnPct: string | null;
    horizonDays: number;
    expectedFeesUsd: string | null;
    impermanentLossUsd: string | null;
    entryCostUsd: string | null;
    exitCostUsd: string | null;
    gasUsd: string | null;
    window: string | null;
  }[];
}

type Level = 'low' | 'medium' | 'high';
export type OpportunityStatus = 'candidate' | 'watch' | 'insufficient_data';

export interface Opportunity {
  readonly id: string;
  readonly protocol: 'rhea' | 'burrow';
  readonly kind: 'liquidity' | 'lending' | 'loop';
  readonly title: string;
  readonly tokens: readonly string[];
  readonly ref: string;
  /** Observed yield, annualised, before costs (Rhea: realised LP fees of a window; Burrow: supply + confirmed rewards). */
  readonly grossApr: number | null;
  readonly grossBasis: string;
  /** After entry/exit costs, gas and IL, from a stored simulation; null when none exists. */
  readonly netApr: number | null;
  readonly netBasis: string | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly priceConfidence: string;
  readonly dataAgeSeconds: number;
  readonly fresh: boolean;
  readonly risk: {
    readonly score: number;
    readonly level: Level;
    readonly factors: readonly Factor[];
  };
  readonly confidence: {
    readonly score: number;
    readonly level: Level;
    readonly notes: readonly string[];
  };
  readonly score: number;
  readonly status: OpportunityStatus;
  readonly why: string;
  readonly reasons: readonly string[];
  readonly limitations: readonly string[];
  readonly detail: Record<string, unknown>;
}

interface Factor {
  readonly name: string;
  /** 0 (no risk) .. 1 (highest). */
  readonly value: number;
  readonly weight: number;
  readonly note: string;
}

const RISK_WEIGHTS = { liquidity: 35, price: 25, structure: 25, history: 15 } as const;
const YIELD_CAP = 0.4;
const THIN_LIQUIDITY_USD = 50_000;
/** Below this, a yield is not worth a position's costs and risk: never a "candidate". */
const MIN_CANDIDATE_APR = 0.01;

/** Candidate = meaningful yield, deep enough, priced, not shown to lose money after costs, risk below medium-high. */
function statusOf(o: {
  grossApr: number | null;
  netApr: number | null;
  liquidityUsd: number | null;
  priceOk: boolean;
  risk: number;
  confidence: number;
}): { status: OpportunityStatus; blocker: string | null } {
  if (o.grossApr === null) return { status: 'insufficient_data', blocker: 'no yield measured yet' };
  const blocker =
    o.netApr !== null && o.netApr <= 0
      ? 'the stored simulation loses money after costs'
      : o.grossApr < MIN_CANDIDATE_APR
        ? 'the yield is below 1% a year'
        : (o.liquidityUsd ?? 0) < THIN_LIQUIDITY_USD
          ? 'liquidity is below $50k'
          : !o.priceOk
            ? 'prices are not confirmed by two sources'
            : o.risk >= 50
              ? 'the risk score is 50 or more'
              : o.confidence < 60
                ? 'the data confidence is below 60'
                : null;
  return { status: blocker ? 'watch' : 'candidate', blocker };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const level = (score: number, inverted = false): Level => {
  const s = inverted ? 100 - score : score;
  return s < 34 ? 'low' : s < 67 ? 'medium' : 'high';
};
const round = (v: number) => Math.round(v * 10) / 10;

function liquidityRisk(usd: number | null): Factor {
  const v =
    usd === null
      ? 1
      : usd < 50e3
        ? 1
        : usd < 250e3
          ? 0.6
          : usd < 1e6
            ? 0.35
            : usd < 5e6
              ? 0.15
              : 0.05;
  return {
    name: 'liquidity',
    value: v,
    weight: RISK_WEIGHTS.liquidity,
    note:
      usd === null
        ? 'liquidity unknown'
        : `$${Math.round(usd).toLocaleString('en-US')} available: ${v >= 0.6 ? 'thin, exit may move the price' : v >= 0.35 ? 'moderate' : 'deep'}`,
  };
}

function priceRisk(quality: string): Factor {
  const v = quality === 'OK' ? 0 : quality === 'LOW_CONFIDENCE' ? 0.6 : 1;
  return {
    name: 'price confidence',
    value: v,
    weight: RISK_WEIGHTS.price,
    note:
      v === 0
        ? 'prices confirmed'
        : v < 1
          ? 'price sources disagree or only one source'
          : 'no usable price',
  };
}

function historyRisk(seconds: number): Factor {
  const v = seconds < 86_400 ? 1 : seconds < 7 * 86_400 ? 0.5 : 0.1;
  return {
    name: 'history',
    value: v,
    weight: RISK_WEIGHTS.history,
    note: `${(seconds / 86_400).toFixed(1)} days of observations`,
  };
}

function riskOf(factors: readonly Factor[]) {
  const total = factors.reduce((s, f) => s + f.value * f.weight, 0);
  const max = factors.reduce((s, f) => s + f.weight, 0);
  const score = round((total / max) * 100);
  return { score, level: level(score), factors };
}

function scoreOf(
  grossApr: number | null,
  risk: number,
  confidence: number,
  liquidityUsd: number | null,
) {
  if (grossApr === null) return 0;
  const yieldPart = (Math.max(0, Math.min(grossApr, YIELD_CAP)) / YIELD_CAP) * 100;
  const s = 0.45 * yieldPart + 0.35 * (100 - risk) + 0.2 * confidence;
  return round((liquidityUsd ?? 0) < THIN_LIQUIDITY_USD ? s / 2 : s);
}

interface Window {
  window: string;
  annualizedApr: string | null;
  volumeUsd: string | null;
  realizedYield: string | null;
  quality: string;
}

const WINDOW_LABEL: Record<string, string> = {
  '1H': '1 hour',
  '24H': '24 hours',
  '7D': '7 days',
  '30D': '30 days',
};

export function rankOpportunities(input: {
  pools: readonly PoolInput[];
  markets: readonly MarketInput[];
  simulations: readonly SimulationInput[];
  /** Token id -> symbol (ft_metadata), for titles and the stablecoin test. */
  symbols: ReadonlyMap<string, string>;
  now: Date;
  /** Collector interval: data older than two cycles is stale. */
  intervalSeconds: number;
  /** Gas per transaction (USD, the orchestrator's estimate) and the horizon costs are spread over. */
  gasUsdPerTx?: number;
  horizonDays?: number;
}): { opportunities: Opportunity[]; excluded: Record<string, number> } {
  const { now, symbols } = input;
  const sym = (t: string) => symbols.get(t) ?? (t.length > 18 ? `${t.slice(0, 8)}…` : t);
  const stable = (t: string) => /USD|DAI|FRAX/i.test(symbols.get(t) ?? '');
  const ageOf = (d: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  const freshLimit = input.intervalSeconds * 2 + 300;
  const excluded: Record<string, number> = {};
  const exclude = (why: string) => {
    excluded[why] = (excluded[why] ?? 0) + 1;
  };

  // Stored LP simulations by pool (the larger demo portfolio: its costs are the smaller share of capital).
  const sims = [...input.simulations].sort((a, b) => (b.capitalUsd ?? 0) - (a.capitalUsd ?? 0));
  const lpSim = (poolKey: string) => {
    for (const s of sims) {
      const r = s.lp.find((x) => x.poolKey === poolKey && x.status === 'OK');
      if (r) return { sim: r, portfolio: s };
    }
    return null;
  };

  const out: Opportunity[] = [];
  const gas = input.gasUsdPerTx ?? 0.05;
  const horizon = input.horizonDays ?? 30;
  // Costs are judged on a real position size: the larger demo portfolio's idle capital ($1,000 if none is stored).
  const refCapital = Math.max(...input.simulations.map((x) => x.capitalUsd ?? 0), 0) || 1000;

  for (const p of input.pools) {
    if (!p.active) continue;
    if (!['LIQUID', 'ANALYTICS_ELIGIBLE', 'LP_SIMULATION_ELIGIBLE'].includes(p.category)) {
      exclude(
        p.category === 'UNSUPPORTED'
          ? 'Rhea: pool model not supported yet'
          : p.category === 'LOW_LIQUIDITY'
            ? 'Rhea: too little liquidity'
            : 'Rhea: not enough data yet',
      );
      continue;
    }
    const latest = (p.latest ?? {}) as { windows?: Window[]; historySeconds?: number };
    const windows = latest.windows ?? [];
    const pick =
      ['30D', '7D', '24H', '1H']
        .map((w) => windows.find((x) => x.window === w && num(x.annualizedApr) !== null))
        .find(Boolean) ?? null;
    const grossApr = pick ? num(pick.annualizedApr) : null;
    const tvl = num(p.tvlUsd);
    const volume = num(windows.find((w) => w.window === '24H')?.volumeUsd);
    const age = ageOf(p.lastSeenAt);
    const fresh = age <= freshLimit;
    const bothStable = p.tokens.length > 0 && p.tokens.every(stable);
    const structure: Factor = {
      name: 'impermanent loss',
      value: bothStable ? 0.15 : 0.7,
      weight: RISK_WEIGHTS.structure,
      note: bothStable
        ? 'both tokens are stablecoins: low price divergence'
        : 'volatile pair: the position loses value when the prices diverge',
    };
    const risk = riskOf([
      liquidityRisk(tvl),
      priceRisk(p.priceQuality),
      structure,
      historyRisk(latest.historySeconds ?? 0),
    ]);
    const s = lpSim(p.poolKey);
    const netApr =
      s && num(s.sim.netReturnPct) !== null
        ? ((num(s.sim.netReturnPct) ?? 0) / 100) * (365 / s.sim.horizonDays)
        : null;
    const notes: string[] = [];
    let confidence = 100;
    if (p.priceQuality !== 'OK') {
      confidence -= 40;
      notes.push('token prices are not confirmed by two sources');
    }
    if (!pick || pick.window === '1H' || pick.window === '24H') {
      confidence -= 25;
      notes.push(
        pick ? `APR from a short ${WINDOW_LABEL[pick.window]} window` : 'no fee window yet',
      );
    }
    if (netApr === null) {
      confidence -= 15;
      notes.push('no stored cost simulation: net yield unknown');
    }
    if (!fresh) {
      confidence -= 10;
      notes.push('data older than two collector cycles');
    }
    confidence = Math.max(0, confidence);
    const score = scoreOf(grossApr, risk.score, confidence, tvl);
    const { status, blocker } = statusOf({
      grossApr,
      netApr,
      liquidityUsd: tvl,
      priceOk: p.priceQuality === 'OK',
      risk: risk.score,
      confidence,
    });
    const title = p.tokens.map(sym).join(' / ');
    const reasons = [
      grossApr !== null && pick
        ? `LP fees earned ${(grossApr * 100).toFixed(2)}% a year over the last ${WINDOW_LABEL[pick.window]} (realised, not a forecast)`
        : 'no fee yield measured yet',
      liquidityRisk(tvl).note,
      structure.note,
    ];
    const limitations = [
      'fees are realised history; future fees depend on future volume',
      ...(netApr === null ? ['net yield not simulated for this pool'] : []),
      'farm rewards are not included (no confirmed farm data)',
    ];
    out.push({
      id: `rhea:${p.poolKey}`,
      protocol: 'rhea',
      kind: 'liquidity',
      title,
      tokens: p.tokens,
      ref: p.poolKey,
      grossApr,
      grossBasis: pick
        ? `realised LP fees, ${WINDOW_LABEL[pick.window]} window, annualised`
        : 'no fee window yet',
      netApr,
      netBasis: s
        ? `stored simulation (${s.portfolio.portfolioId}, $${Math.round(s.portfolio.capitalUsd ?? 0).toLocaleString('en-US')}, ${s.sim.horizonDays} days): fees − IL − entry/exit cost − gas, annualised`
        : null,
      liquidityUsd: tvl,
      volume24hUsd: volume,
      priceConfidence: p.priceQuality,
      dataAgeSeconds: age,
      fresh,
      risk,
      confidence: { score: confidence, level: level(confidence, true), notes },
      score,
      status,
      why:
        status === 'candidate'
          ? `${grossApr !== null ? (grossApr * 100).toFixed(1) : '—'}% realised fee yield with ${risk.level} risk and confirmed prices.`
          : status === 'watch'
            ? `Watch only: ${blocker ?? 'see the risk factors'}.`
            : 'Not enough data to measure a yield yet.',
      reasons,
      limitations,
      detail: {
        family: p.family,
        poolType: p.poolType,
        feeBps: p.feeBps,
        category: p.category,
        windows,
        simulation: s?.sim ?? null,
      },
    });
  }

  for (const m of input.markets) {
    const x = (m.latest ?? {}) as {
      status?: string;
      supplyApr?: string | null;
      rewardApr?: string | null;
      netSupplyApr?: string | null;
      utilization?: string | null;
      availableUsd?: string | null;
      canDeposit?: boolean;
      collateralFactor?: number;
      canUseAsCollateral?: boolean;
      activeRewardProgrammes?: number;
      risk?: string[];
    };
    if (x.canDeposit === false) {
      exclude('Burrow: deposits closed');
      continue;
    }
    if (x.status !== 'OK' && x.status !== 'LOW_CONFIDENCE') {
      exclude('Burrow: market data not usable');
      continue;
    }
    const supply = num(x.supplyApr);
    if (supply === null || supply <= 0) {
      exclude('Burrow: no supply yield');
      continue;
    }
    const grossApr = num(x.netSupplyApr) ?? supply;
    const util = num(x.utilization);
    const liquidity = num(x.availableUsd);
    const age = ageOf(m.lastSeenAt);
    const fresh = age <= freshLimit;
    const structure: Factor = {
      name: 'utilisation',
      value: util === null ? 0.5 : util > 0.9 ? 0.8 : util > 0.8 ? 0.4 : 0.1,
      weight: RISK_WEIGHTS.structure,
      note:
        util === null
          ? 'utilisation unknown'
          : `${(util * 100).toFixed(1)}% borrowed${util > 0.9 ? ': withdrawals may have to wait for repayments' : util > 0.8 ? ': high, the rate moves fast' : ''}`,
    };
    const priceQuality = x.status === 'OK' ? 'OK' : 'LOW_CONFIDENCE';
    const risk = riskOf([
      liquidityRisk(liquidity),
      priceRisk(priceQuality),
      structure,
      historyRisk(7 * 86_400), // the rate is read from the contract each cycle; history length is not the limit here
    ]);
    const notes: string[] = [];
    let confidence = 100;
    if (priceQuality !== 'OK') {
      confidence -= 40;
      notes.push('the asset price is not confirmed by two sources');
    }
    confidence -= 10;
    notes.push('rate at current utilisation: it changes as soon as utilisation does');
    if (!fresh) {
      confidence -= 10;
      notes.push('data older than two collector cycles');
    }
    confidence = Math.max(0, confidence);
    const burrowNet = grossApr - ((2 * gas) / refCapital) * (365 / horizon);
    const score = scoreOf(grossApr, risk.score, confidence, liquidity);
    const { status, blocker } = statusOf({
      grossApr,
      netApr: burrowNet,
      liquidityUsd: liquidity,
      priceOk: priceQuality === 'OK',
      risk: risk.score,
      confidence,
    });
    out.push({
      id: `burrow:${m.token}`,
      protocol: 'burrow',
      kind: 'lending',
      title: `Supply ${sym(m.token)}`,
      tokens: [m.token],
      ref: m.token,
      grossApr,
      grossBasis: num(x.rewardApr)
        ? 'supply rate + confirmed base rewards, at current utilisation'
        : 'supply rate at current utilisation',
      netApr: burrowNet,
      netBasis: `$${Math.round(refCapital).toLocaleString('en-US')} for ${horizon} days: supply rate minus gas to deposit and withdraw (2 × $${gas.toFixed(2)}); no swap (the asset is already held), no impermanent loss`,
      liquidityUsd: liquidity,
      volume24hUsd: null,
      priceConfidence: priceQuality,
      dataAgeSeconds: age,
      fresh,
      risk,
      confidence: { score: confidence, level: level(confidence, true), notes },
      score,
      status,
      why:
        status === 'candidate'
          ? `${(grossApr * 100).toFixed(1)}% supply yield, ${risk.level} risk, deep and priced market.`
          : `Watch only: ${blocker ?? 'see the risk factors'}.`,
      reasons: [
        `Burrow pays ${(supply * 100).toFixed(2)}% a year to suppliers right now`,
        liquidityRisk(liquidity).note,
        structure.note,
      ],
      limitations: [
        'a variable rate: not a guaranteed return',
        'no impermanent loss, but the supplied asset keeps its own price risk',
        'net yield assumes the asset is already held (no swap into it)',
      ],
      detail: {
        supplyApr: supply,
        rewardApr: num(x.rewardApr),
        utilization: util,
        collateralFactor: x.collateralFactor ?? null,
        canUseAsCollateral: x.canUseAsCollateral ?? null,
        activeRewardProgrammes: x.activeRewardProgrammes ?? 0,
        riskFlags: x.risk ?? [],
      },
    });
  }

  // Same-asset loops (looping.ts): shown for comparison, never a candidate - the autopilot cannot borrow.
  for (const m of input.markets) {
    const l = loopFor(
      { ...(m.latest as LoopMarket), token: m.token },
      { equityUsd: refCapital, targetHealthFactor: 1.6, gasUsdPerTx: gas, horizonDays: horizon },
    );
    if (!l) continue;
    const netApr = (l.netUsd / l.equityUsd) * (365 / l.horizonDays);
    const risk = riskOf([
      liquidityRisk(num((m.latest as LoopMarket).availableUsd)),
      priceRisk('OK'),
      {
        name: 'leverage',
        value: 0.8,
        weight: RISK_WEIGHTS.structure,
        note: `${l.leverage.toFixed(1)}× leverage: loses money if the borrow rate rises above ${(l.breakEvenBorrowApr * 100).toFixed(1)}%`,
      },
      historyRisk(7 * 86_400),
    ]);
    out.push({
      id: `loop:${m.token}`,
      protocol: 'burrow',
      kind: 'loop',
      title: `Loop ${sym(m.token)} (${l.leverage.toFixed(1)}×)`,
      tokens: [m.token],
      ref: m.token,
      grossApr: l.leverage * l.supplyApr,
      grossBasis: `supply rate on ${l.leverage.toFixed(2)}× the capital, before borrowing costs`,
      netApr,
      netBasis: `$${Math.round(refCapital).toLocaleString('en-US')}, ${horizon} days: L × supply − (L − 1) × borrow − gas for ${2 * (1 + 2 * l.rounds)} transactions; health factor held at 1.6`,
      liquidityUsd: num((m.latest as LoopMarket).availableUsd),
      volume24hUsd: null,
      priceConfidence: 'OK',
      dataAgeSeconds: ageOf(m.lastSeenAt),
      fresh: ageOf(m.lastSeenAt) <= freshLimit,
      risk,
      confidence: {
        score: 70,
        level: level(70, true),
        notes: ['rates at current utilisation; a loop is very sensitive to them'],
      },
      score:
        scoreOf(
          netApr > 0 ? netApr : 0,
          risk.score,
          70,
          num((m.latest as LoopMarket).availableUsd),
        ) / 2,
      status: 'watch',
      why:
        netApr > 0
          ? `Comparison only: ${(netApr * 100).toFixed(1)}% a year after costs, but the autopilot cannot borrow.`
          : `Comparison only: loses ${(Math.abs(netApr) * 100).toFixed(1)}% a year after borrowing costs and gas at this size.`,
      reasons: [
        `Deposits ${l.leverage.toFixed(2)}× the capital at ${(l.supplyApr * 100).toFixed(2)}% and borrows ${(l.leverage - 1).toFixed(2)}× at ${(l.borrowApr * 100).toFixed(2)}%`,
      ],
      limitations: [
        "the autopilot's safety policy has no borrow action: simulation only",
        l.daysToLiquidationFromRates === null
          ? "at today's rates the health factor does not drift down"
          : `at today's rates the health factor reaches 1.0 in about ${Math.round(l.daysToLiquidationFromRates)} days without a top-up`,
      ],
      detail: { loop: l },
    });
  }

  // Candidates first, then watch, then no data; within a group by score, then by depth.
  const group = { candidate: 0, watch: 1, insufficient_data: 2 } as const;
  out.sort(
    (a, b) =>
      group[a.status] - group[b.status] ||
      b.score - a.score ||
      (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
  );
  return { opportunities: out, excluded };
}
