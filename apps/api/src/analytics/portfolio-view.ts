import { orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CollectorStore } from '../collector/store';
import {
  DEMO_PORTFOLIOS,
  type DemoPortfolio,
  type DemoPortfolioId,
} from '../simulation/demo-portfolios';
import { DemoLedgerStore } from '../simulation/ledger';
import { loopStrategies, type LoopMarket } from './looping';

/**
 * The PRODUCT view of a demo portfolio, for the home page: what it holds (simulated amounts at real mainnet prices),
 * how safe it is, what it earns, the actions one could take with it (each with its net result after costs and the
 * autopilot's own view), and the agent's decisions in plain language. Read-only; every figure comes from stored
 * observations or from the collector's stored analysis, except the loop maths (looping.ts), computed here from the
 * stored Burrow markets.
 */
const ORCH = orchestratorConfigSchema.parse({});
const HURDLE = { minNetUsd: ORCH.swap.minNetBenefitUsd, multiple: ORCH.swap.costCoverMultiple };
const TARGET_HF = ORCH.risk.targetHealthFactorBps / 10_000;
const WATCH_HF = ORCH.risk.watchBelowBps / 10_000;
const GAS = ORCH.swap.estimatedGasUsd;
const HORIZON = ORCH.swap.horizonDays;
const NEAR_TOKEN = 'wrap.near';
const USDT_TOKEN = 'usdt.tether-token.near';

type Risk = 'low' | 'medium' | 'high';
export interface PortfolioAction {
  readonly id: string;
  readonly kind: 'lend' | 'liquidity' | 'loop' | 'keep';
  readonly title: string;
  readonly summary: string;
  readonly capitalUsd: number;
  readonly horizonDays: number;
  readonly grossUsd: number | null;
  readonly netUsd: number | null;
  readonly netAprOnCapital: number | null;
  readonly costs: readonly { readonly label: string; readonly usd: number }[];
  readonly risk: Risk;
  readonly steps: readonly string[];
  readonly risks: readonly string[];
  readonly basis: string;
  readonly autopilot: {
    readonly verdict: 'worth_it' | 'not_worth_it' | 'not_allowed' | 'no_data';
    readonly sentence: string;
  };
}

interface Strategy {
  strategy: string;
  label: string;
  capitalUsd: number;
  horizonDays: number;
  grossReturnUsd: number | null;
  netReturnUsd: number | null;
  feesUsd: number;
  gasUsd: number;
  slippageUsd: number;
  impermanentLossUsd: number;
  basis: string;
  liquidityRisk: string;
}
interface StoredRisk {
  level?: string;
  ltvBps?: string | null;
  healthFactorWad?: string | null;
  collateralUsdMicro?: string | null;
  debtUsdMicro?: string | null;
}
interface Decision {
  outcome?: string;
  reasons?: string[];
  risk?: StoredRisk;
  ranked?: {
    agent: string;
    action: { kind: string; tokenIn?: string; tokenOut?: string };
    economics?: { valueInUsdMicro?: string; benefitUsdMicro?: string; costUsdMicro?: string };
  }[];
  rejected?: {
    agent: string;
    kind: string;
    code: string;
    detail: string;
    economics?: {
      tokenIn?: string;
      tokenOut?: string;
      valueInUsdMicro?: string;
      benefitUsdMicro?: string;
      costUsdMicro?: string;
      netUsdMicro?: string;
    };
  }[];
  agentNoActions?: { agent: string; reasonCode: string }[];
}
interface AnalysisResult {
  portfolio?: { walletUsd?: number | null; capitalUsd?: number };
  strategies?: Strategy[];
  decision?: Decision | null;
  lpSimulations?: { poolKey: string; status: string }[];
}

export const money = (v: number) =>
  `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0, minimumFractionDigits: Math.abs(v) < 100 ? 2 : 0 })}`;
const micro = (v: string | null | undefined) => (v ? Number(v) / 1e6 : null);
const wad = (v: string | null | undefined) => (v ? Number(BigInt(v) / 10n ** 12n) / 1e6 : null);

export function hurdle(
  net: number | null,
  gross: number | null,
  costs: number,
): PortfolioAction['autopilot'] {
  if (net === null || gross === null)
    return { verdict: 'no_data', sentence: 'Not enough market data to judge it.' };
  if (net >= HURDLE.minNetUsd && (costs === 0 || gross >= HURDLE.multiple * costs))
    return {
      verdict: 'worth_it',
      sentence: `Clears the autopilot's bar: at least ${money(HURDLE.minNetUsd)} left after costs, and the gain is at least ${HURDLE.multiple}× the costs.`,
    };
  return {
    verdict: 'not_worth_it',
    sentence:
      net < HURDLE.minNetUsd
        ? `Not worth it for the autopilot: it would keep ${money(net)} after costs; it needs at least ${money(HURDLE.minNetUsd)}.`
        : `Not worth it for the autopilot: the gain is less than ${HURDLE.multiple}× the costs, too thin a margin if the rate moves.`,
  };
}

export function buildPortfolioView(i: {
  id: DemoPortfolioId;
  analysis: { createdAt: Date; result: unknown } | null;
  prices: ReadonlyMap<string, number>;
  markets: readonly (LoopMarket & { token: string })[];
  symbols: ReadonlyMap<string, string>;
  /** The demo portfolio as it stands now (simulated ledger applied); default: its base amounts. */
  current?: { portfolio: DemoPortfolio; changes: number; since: Date | null };
}) {
  const p = i.current?.portfolio ?? DEMO_PORTFOLIOS[i.id];
  const sym = (t: string) => i.symbols.get(t) ?? (t === NEAR_TOKEN ? 'wNEAR' : t.slice(0, 8));
  const near = i.prices.get(NEAR_TOKEN) ?? null;
  const usdt = i.prices.get(USDT_TOKEN) ?? null;
  const amt = (raw: bigint, dec: number) => Number(raw / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6;
  const row = (where: string, symbol: string, amount: number, price: number | null) => ({
    where,
    symbol,
    amount,
    usd: price === null ? null : amount * price,
  });
  const holdings = [
    row('wallet', 'NEAR', amt(p.wallet.near, 24), near),
    row('wallet', 'USDt', amt(p.wallet.usdt, 6), usdt),
    row('collateral', 'NEAR', amt(p.collateral.near, 24), near),
    ...(p.supplied.usdt > 0n ? [row('deposited', 'USDt', amt(p.supplied.usdt, 6), usdt)] : []),
    ...((p.supplied.near ?? 0n) > 0n
      ? [row('deposited', 'NEAR', amt(p.supplied.near ?? 0n, 24), near)]
      : []),
    row('borrowed', 'USDt', amt(p.borrowed.usdt, 6), usdt),
  ];
  const sum = (f: (h: (typeof holdings)[number]) => boolean) =>
    holdings.filter(f).reduce((s, h) => s + (h.usd ?? NaN), 0);
  const assetsUsd = sum((h) => h.where !== 'borrowed');
  const debtUsd = sum((h) => h.where === 'borrowed');
  const idleUsd = sum((h) => h.where === 'wallet');

  const result = (i.analysis?.result ?? {}) as AnalysisResult;
  const risk = result.decision?.risk ?? null;
  // Burrow's health factor from the CURRENT amounts at live prices: collateral x vr / (debt / vr). It follows a
  // simulated repayment at once; the stored analysis is the fallback when a price or a risk parameter is missing.
  const vr = (t: string) => i.markets.find((m) => m.token === t)?.collateralFactor;
  const collUsd = near === null ? null : amt(p.collateral.near, 24) * near;
  const debtNow = usdt === null ? null : amt(p.borrowed.usdt, 6) * usdt;
  const vrNear = vr(NEAR_TOKEN);
  const vrUsdt = vr(USDT_TOKEN);
  const liveHf =
    collUsd !== null && debtNow !== null && vrNear && vrUsdt
      ? debtNow > 0
        ? (collUsd * vrNear) / (debtNow / vrUsdt)
        : null
      : undefined;
  const hf = liveHf === undefined ? wad(risk?.healthFactorWad) : liveHf;
  const drop = hf !== null && hf > 1 ? 1 - 1 / hf : null;
  const healthLevel: Risk =
    hf === null ? 'high' : hf >= WATCH_HF ? 'low' : hf >= 1.1 ? 'medium' : 'high';
  const health = {
    healthFactor: hf,
    level: healthLevel,
    label:
      hf === null
        ? 'Unknown'
        : healthLevel === 'low'
          ? 'Safe'
          : healthLevel === 'medium'
            ? 'Needs watching'
            : 'At risk',
    sentence:
      hf === null
        ? 'The health of the loan could not be computed from the latest data.'
        : drop !== null
          ? `The loan stays safe unless NEAR falls ${(drop * 100).toFixed(0)}% from today's price.`
          : 'The loan can be liquidated now.',
  };

  const strategies = result.strategies ?? [];
  const stored = strategies.find((s) => s.strategy === 'CURRENT_STRUCTURE');
  // The current position's monthly result from the CURRENT amounts and today's Burrow rates (deposits earn, the loan
  // costs); the stored analysis is the fallback.
  const r = (t: string, f: 'netSupplyApr' | 'borrowApr') => {
    const m = i.markets.find((x) => x.token === t);
    const v =
      m && (m as { status?: string }).status === 'OK'
        ? (m[f] ?? (f === 'netSupplyApr' ? m.supplyApr : null))
        : null;
    return v === null || v === undefined ? null : Number(v);
  };
  const sNear = r(NEAR_TOKEN, 'netSupplyApr');
  const sUsdt = r(USDT_TOKEN, 'netSupplyApr');
  const bUsdt = r(USDT_TOKEN, 'borrowApr');
  const liveMonthly =
    near !== null && usdt !== null && sNear !== null && sUsdt !== null && bUsdt !== null
      ? ((amt(p.collateral.near, 24) + amt(p.supplied.near ?? 0n, 24)) * near * sNear +
          amt(p.supplied.usdt, 6) * usdt * sUsdt -
          amt(p.borrowed.usdt, 6) * usdt * bUsdt) *
        (HORIZON / 365)
      : null;
  const current = { netReturnUsd: liveMonthly ?? stored?.netReturnUsd ?? null };
  const actions: PortfolioAction[] = [];
  for (const s of strategies) {
    if (s.strategy === 'HOLD' || s.strategy === 'CURRENT_STRUCTURE') continue;
    const costs = [
      { label: 'Network fees (gas)', usd: s.gasUsd },
      { label: 'Swap cost and price impact', usd: s.slippageUsd },
      { label: 'Impermanent loss (estimate)', usd: s.impermanentLossUsd },
    ].filter((c) => c.usd > 0.0005);
    const costTotal = costs.reduce((a, c) => a + c.usd, 0);
    const base = {
      capitalUsd: s.capitalUsd,
      horizonDays: s.horizonDays,
      grossUsd: s.grossReturnUsd,
      netUsd: s.netReturnUsd,
      netAprOnCapital:
        s.netReturnUsd === null || s.capitalUsd <= 0
          ? null
          : (s.netReturnUsd / s.capitalUsd) * (365 / s.horizonDays),
      costs,
      basis: s.basis,
      autopilot: hurdle(s.netReturnUsd, s.grossReturnUsd, costTotal),
    };
    if (s.strategy === 'RHEA_LP_BEST' && s.netReturnUsd !== null) {
      const lpKey = /v1:\d+/.exec(s.label)?.[0];
      actions.push({
        ...base,
        id: 'liquidity',
        kind: 'liquidity',
        title: `Provide liquidity on Rhea${lpKey ? ` (pool #${lpKey.slice(3)})` : ''}`,
        autopilot:
          base.autopilot.verdict === 'worth_it'
            ? {
                verdict: 'not_allowed',
                sentence:
                  'Worth it by the numbers, but the autopilot cannot open liquidity positions yet: it only advises on them.',
              }
            : base.autopilot,
        summary:
          'Earn a share of the trading fees of the pool. Fees are realised history, not a promise.',
        risk: 'medium',
        steps: [
          'Swap half of the capital into the other token of the pool.',
          'Add both tokens to the pool; collect fees as people trade.',
          'Remove liquidity and swap back to exit.',
        ],
        risks: [
          'Impermanent loss when the two prices move apart.',
          'Fees depend on future trading volume.',
          'Exit costs grow if the pool is shallow.',
        ],
      });
    }
  }

  // Lending and repaying, computed here from the live Burrow rates on the EXACT idle amounts of each token.
  const rate = (t: string, f: 'netSupplyApr' | 'borrowApr') => {
    const m = i.markets.find((x) => x.token === t);
    const v = m?.status === 'OK' ? (m[f] ?? (f === 'netSupplyApr' ? m.supplyApr : null)) : null;
    return v === null || v === undefined ? null : Number(v);
  };
  const H = HORIZON / 365;
  const walletNearUsd = holdings[0]?.usd ?? null;
  const walletUsdtUsd = holdings[1]?.usd ?? null;
  const borrowUsdt = rate(USDT_TOKEN, 'borrowApr');
  const supplyUsdt = rate(USDT_TOKEN, 'netSupplyApr');
  const supplyNear = rate(NEAR_TOKEN, 'netSupplyApr');
  const simple = (o: {
    id: string;
    kind: PortfolioAction['kind'];
    title: string;
    summary: string;
    capital: number | null;
    gross: number | null;
    costs: { label: string; usd: number }[];
    risk: Risk;
    steps: string[];
    risks: string[];
    basis: string;
    autopilot?: PortfolioAction['autopilot'];
  }) => {
    if (o.capital === null || o.capital <= 0 || o.gross === null) return;
    const costTotal = o.costs.reduce((a, c) => a + c.usd, 0);
    const net = o.gross - costTotal;
    actions.push({
      id: o.id,
      kind: o.kind,
      title: o.title,
      summary: o.summary,
      capitalUsd: o.capital,
      horizonDays: HORIZON,
      grossUsd: o.gross,
      netUsd: net,
      netAprOnCapital: (net / o.capital) * (365 / HORIZON),
      costs: o.costs,
      risk: o.risk,
      steps: o.steps,
      risks: o.risks,
      basis: o.basis,
      autopilot: o.autopilot ?? hurdle(net, o.gross, costTotal),
    });
  };
  if (walletUsdtUsd !== null && borrowUsdt !== null && Number.isFinite(debtUsd) && debtUsd > 0) {
    const repay = Math.min(walletUsdtUsd, debtUsd);
    const newHf = hf !== null && debtUsd - repay > 0 ? (hf * debtUsd) / (debtUsd - repay) : null;
    simple({
      id: 'repay',
      kind: 'keep',
      title: `Repay ${money(repay)} of the loan with your idle USDt`,
      summary: `The loan costs ${(borrowUsdt * 100).toFixed(1)}% a year; the idle USDt earns nothing in the wallet. Repaying saves that interest and makes the loan safer.`,
      capital: repay,
      gross: repay * borrowUsdt * H,
      costs: [{ label: 'Network fee (gas)', usd: GAS }],
      risk: 'low',
      steps: [
        `Repay ${money(repay)} USDt of the ${money(debtUsd)} Burrow loan.`,
        newHf !== null
          ? `The health factor rises from ${hf?.toFixed(2)} to about ${newHf.toFixed(2)}.`
          : 'The loan is fully repaid.',
      ],
      risks: ['You no longer have this USDt at hand; borrowing it again later costs gas.'],
      basis: `Interest saved = repaid amount × the current USDt borrow rate (${(borrowUsdt * 100).toFixed(2)}%) × ${HORIZON}/365. Rates change.`,
      autopilot:
        hf !== null && hf < WATCH_HF
          ? {
              verdict: 'worth_it',
              sentence:
                'The autopilot does this itself when the loan gets close to the safety line.',
            }
          : {
              verdict: 'not_allowed',
              sentence: `The autopilot would not do this on its own: it repays only to protect the loan (health factor below ${WATCH_HF}), not to save interest. You can ask it to.`,
            },
    });
  }
  if (walletUsdtUsd !== null && supplyUsdt !== null)
    simple({
      id: 'lend-usdt',
      kind: 'lend',
      title: 'Lend your idle USDt on Burrow',
      summary: 'Deposit the USDt sitting in the wallet and earn the supply rate. No swap needed.',
      capital: walletUsdtUsd,
      gross: walletUsdtUsd * supplyUsdt * H,
      costs: [{ label: 'Network fees (deposit and withdraw)', usd: 2 * GAS }],
      risk: 'low',
      steps: [
        `Deposit ${money(walletUsdtUsd)} USDt into Burrow at ${(supplyUsdt * 100).toFixed(2)}% a year.`,
        'Withdraw at any time while the market has liquidity.',
      ],
      risks: [
        'Variable rate.',
        'Withdrawals can wait when almost everything is borrowed.',
        'Smart-contract risk.',
      ],
      basis: `Current USDt supply rate × ${HORIZON}/365, not compounded.`,
    });
  if (walletNearUsd !== null && supplyNear !== null)
    simple({
      id: 'lend-near',
      kind: 'lend',
      title: 'Lend your idle NEAR on Burrow',
      summary: 'Deposit the NEAR sitting in the wallet and earn its supply rate. No swap needed.',
      capital: walletNearUsd,
      gross: walletNearUsd * supplyNear * H,
      costs: [{ label: 'Network fees (deposit and withdraw)', usd: 2 * GAS }],
      risk: 'low',
      steps: [
        `Deposit ${money(walletNearUsd)} of NEAR into Burrow at ${(supplyNear * 100).toFixed(2)}% a year.`,
      ],
      risks: [
        'The NEAR supply rate is very low right now.',
        'NEAR keeps its own price risk.',
        'Smart-contract risk.',
      ],
      basis: `Current NEAR supply rate × ${HORIZON}/365, not compounded.`,
    });
  const bestStable = strategies.find((x) => x.strategy === 'BURROW_SUPPLY_BEST');
  const stableId = bestStable ? /(17208628|usdc|usdt|dai)/i.exec(bestStable.label)?.[0] : undefined;
  const stableToken = stableId
    ? i.markets.find((m) => m.token.toLowerCase().startsWith(stableId.toLowerCase()))?.token
    : undefined;
  const stableRate = stableToken ? rate(stableToken, 'netSupplyApr') : null;
  if (
    bestStable &&
    stableToken &&
    stableRate !== null &&
    walletNearUsd !== null &&
    bestStable.capitalUsd > 0
  ) {
    // the stored swap cost is for the whole idle capital; scaled to the NEAR part (impact is roughly linear at this size)
    const swap = bestStable.slippageUsd * (walletNearUsd / bestStable.capitalUsd);
    simple({
      id: 'lend-stable',
      kind: 'lend',
      title: `Swap idle NEAR to ${sym(stableToken)} and lend it on Burrow`,
      summary: `${sym(stableToken)} earns a much higher supply rate than NEAR; the swap has a one-off cost.`,
      capital: walletNearUsd,
      gross: walletNearUsd * stableRate * H,
      costs: [
        { label: 'Swap cost and price impact (estimate)', usd: swap },
        { label: 'Network fees (swap, deposit, withdraw)', usd: 3 * GAS },
      ],
      risk: 'low',
      steps: [
        `Swap ${money(walletNearUsd)} of NEAR to ${sym(stableToken)} on Rhea.`,
        `Deposit it into Burrow at ${(stableRate * 100).toFixed(2)}% a year.`,
      ],
      risks: [
        'You give up NEAR price exposure on this part (up or down).',
        'Stablecoin peg risk; variable rate; smart-contract risk.',
      ],
      basis:
        'Swap cost from the pool reserves (fee + price impact vs the reference price), scaled to the NEAR amount; current supply rate.',
    });
  }

  // Looping: same-asset loops on the idle capital (for assets other than NEAR, a swap first, costed like the stable swap).
  const swapCost = strategies.find((s) => s.strategy === 'BURROW_SUPPLY_BEST')?.slippageUsd ?? null;
  const loops = loopStrategies(i.markets, {
    equityUsd: Number.isFinite(idleUsd) ? idleUsd : 0,
    targetHealthFactor: TARGET_HF,
    gasUsdPerTx: GAS,
    horizonDays: HORIZON,
  }).filter((l) => l.token === NEAR_TOKEN || (swapCost !== null && l.supplyApr > 0.01));
  for (const l of loops.slice(0, 2)) {
    const needsSwap = l.token !== NEAR_TOKEN;
    // only the NEAR part of the idle capital has to be swapped (the stored cost is for the whole idle amount)
    const nearShare = walletNearUsd !== null && idleUsd > 0 ? walletNearUsd / idleUsd : 1;
    const swap = needsSwap ? (swapCost ?? 0) * (l.token === USDT_TOKEN ? nearShare : 1) : 0;
    const net = l.netUsd - swap;
    actions.push({
      id: `loop-${l.token}`,
      kind: 'loop',
      title: `Loop ${sym(l.token)} on Burrow (${l.leverage.toFixed(1)}× leverage)`,
      summary: `Deposit ${sym(l.token)}, borrow ${sym(l.token)} against it and deposit again, ${l.rounds} times: earns the supply rate on ${money(l.depositedUsd)} and pays the borrow rate on ${money(l.borrowedUsd)}.`,
      capitalUsd: l.equityUsd,
      horizonDays: l.horizonDays,
      grossUsd: l.grossUsd,
      netUsd: net,
      netAprOnCapital: l.equityUsd > 0 ? (net / l.equityUsd) * (365 / l.horizonDays) : null,
      costs: [
        { label: `Interest on ${money(l.borrowedUsd)} borrowed`, usd: l.borrowCostUsd },
        {
          label: `Network fees (${2 * (1 + 2 * l.rounds)} transactions in and out)`,
          usd: l.gasUsd,
        },
        ...(needsSwap ? [{ label: `Swap the NEAR part to ${sym(l.token)} first`, usd: swap }] : []),
      ],
      risk: 'high',
      steps: [
        ...(needsSwap ? [`Swap the idle NEAR to ${sym(l.token)}.`] : []),
        `Deposit ${money(l.equityUsd)} of ${sym(l.token)} into Burrow as collateral.`,
        `Borrow ${sym(l.token)} against it and deposit it again; repeat ${l.rounds} times.`,
        `End state: ${money(l.depositedUsd)} deposited, ${money(l.borrowedUsd)} borrowed, health factor ${l.targetHealthFactor.toFixed(2)}.`,
      ],
      risks: [
        `It loses money if the ${sym(l.token)} borrow rate rises above ${(l.breakEvenBorrowApr * 100).toFixed(1)}% (now ${(l.borrowApr * 100).toFixed(1)}%).`,
        l.daysToLiquidationFromRates === null
          ? "At today's rates the health factor does not drift down."
          : `At today's rates the health factor drifts down and reaches 1.0 in about ${Math.round(l.daysToLiquidationFromRates)} days without a top-up.`,
        ...(l.fitsLiquidity
          ? []
          : ['The market does not have enough liquidity to borrow this much right now.']),
        'Leverage multiplies smart-contract and rate risk.',
      ],
      basis: `Burrow health factor with the same asset on both sides: leverage = ${TARGET_HF} / (${TARGET_HF} − vr²), vr² = ${((TARGET_HF * (l.leverage - 1)) / l.leverage).toFixed(4)}. Today's rates held for ${l.horizonDays} days; not compounded.`,
      autopilot: {
        verdict: 'not_allowed',
        sentence:
          'The autopilot will not do this: its safety policy has no borrow action. Shown so you can compare.',
      },
    });
  }
  actions.sort((a, b) => (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity));

  return {
    id: i.id,
    label: `$${p.grossUsd.toLocaleString('en-US')} demo portfolio`,
    simulated: true,
    asOf: i.analysis?.createdAt.toISOString() ?? null,
    holdings,
    totals: { assetsUsd, debtUsd, netWorthUsd: assetsUsd - debtUsd, idleUsd },
    health,
    earnings: {
      monthlyNetUsd: current?.netReturnUsd ?? null,
      sentence:
        current?.netReturnUsd === null || current?.netReturnUsd === undefined
          ? 'Earnings could not be computed from the latest data.'
          : current.netReturnUsd >= 0
            ? `The current position earns about ${money(current.netReturnUsd)} a month after interest.`
            : `The current position costs about ${money(-current.netReturnUsd)} a month: the loan's interest is higher than what the deposits earn.`,
    },
    actions,
    lastDecision: i.analysis ? narrate(i.analysis.result as AnalysisResult, i.symbols) : null,
    /** Dry-run actions applied to this demo portfolio since its last reset (simulated ledger). */
    simulatedChanges: i.current
      ? { count: i.current.changes, since: i.current.since?.toISOString() ?? null }
      : null,
  };
}

/** One analysis in plain words: what each agent saw, what was proposed, what was decided and why. */
export function narrate(r: AnalysisResult, symbols: ReadonlyMap<string, string>) {
  const sym = (t?: string) =>
    t ? (symbols.get(t) ?? (t === NEAR_TOKEN ? 'wNEAR' : t.slice(0, 8))) : 'a token';
  const d = r.decision;
  const hf = wad(d?.risk?.healthFactorWad);
  const notes: string[] = [];
  for (const n of d?.agentNoActions ?? []) {
    if (n.agent === 'liquidation-guardian' && n.reasonCode === 'healthy')
      notes.push(
        `Loan guardian: health factor ${hf?.toFixed(2) ?? '—'} is above the ${WATCH_HF} safety line, so no repayment is needed.`,
      );
    else if (n.agent === 'lp-optimizer' && n.reasonCode === 'insufficient_data')
      notes.push('Liquidity manager: there are no liquidity positions to manage.');
    else if (n.agent === 'market-intelligence' && n.reasonCode === 'healthy')
      notes.push('Market watcher: prices and liquidity look normal.');
    else notes.push(`${n.agent.replace(/-/g, ' ')}: ${n.reasonCode.replace(/_/g, ' ')}.`);
  }
  for (const x of d?.rejected ?? []) {
    const e = x.economics;
    const what =
      x.kind === 'lending.supply'
        ? `deposit ${e?.valueInUsdMicro ? `${money(micro(e.valueInUsdMicro) ?? 0)} of ` : ''}idle ${sym(e?.tokenIn)} into Burrow`
        : x.kind === 'allocation.swap'
          ? e?.tokenIn && e.tokenOut
            ? `swap ${e.valueInUsdMicro ? `${money(micro(e.valueInUsdMicro) ?? 0)} of ` : ''}${sym(e.tokenIn)} into ${sym(e.tokenOut)} to earn a better rate`
            : 'move idle NEAR into a better-earning asset'
          : x.kind.replace(/[._]/g, ' ');
    const why =
      x.code === 'NO_QUOTE'
        ? 'no reliable swap price was available for that amount'
        : x.code === 'BELOW_HURDLE'
          ? `the expected gain (${money(micro(e?.benefitUsdMicro) ?? 0)} a month) does not beat the cost (${money(micro(e?.costUsdMicro) ?? 0)}) by enough`
          : x.code === 'RISK_NOT_HEALTHY'
            ? 'the loan is not healthy enough to take on an optional trade'
            : x.detail;
    notes.push(`Capital allocator wanted to ${what}, but ${why}.`);
  }
  for (const x of d?.ranked ?? []) {
    const e = x.economics;
    notes.push(
      `Proposed: ${x.action.kind === 'lending.supply' ? `deposit ${money(micro(e?.valueInUsdMicro) ?? 0)} of idle ${sym((x.action as { token?: string }).token)} into Burrow (expected +${money(micro(e?.benefitUsdMicro) ?? 0)} a month, cost ${money(micro(e?.costUsdMicro) ?? 0)})` : x.action.kind === 'allocation.swap' ? `swap ${money(micro(e?.valueInUsdMicro) ?? 0)} of ${sym(x.action.tokenIn)} into ${sym(x.action.tokenOut)} (expected +${money(micro(e?.benefitUsdMicro) ?? 0)}, cost ${money(micro(e?.costUsdMicro) ?? 0)})` : x.action.kind.replace(/[._]/g, ' ')}. Sent to the safety policy.`,
    );
  }
  const REASON: Record<string, string> = {
    NO_CANDIDATES: 'No agent proposed anything.',
    MODE_READ_ONLY: 'The autopilot is in read-only mode: nothing may run.',
    DATA_UNTRUSTWORTHY: 'The market data was not trustworthy enough to act on.',
    PRICES_STALE: 'Prices were out of date, so nothing was decided.',
    DATA_NOT_FRESH:
      'Market data was out of date, so the autopilot did nothing (a safety rule: it never acts on stale prices).',
  };
  if (notes.length === 0)
    for (const reason of d?.reasons ?? [])
      notes.push(
        REASON[reason] ??
          `${reason
            .replace(/_/g, ' ')
            .toLowerCase()
            .replace(/^\w/, (c) => c.toUpperCase())}.`,
      );
  const headline = d?.reasons?.includes('DATA_NOT_FRESH')
    ? 'Skipped: market data out of date'
    : d?.outcome === 'act'
      ? 'Proposed an action'
      : d?.outcome === 'no_action'
        ? 'No action: nothing worth doing'
        : d
          ? (d.outcome ?? 'Checked')
          : 'Could not analyse (data missing)';
  return { outcome: d?.outcome ?? null, headline, notes };
}

const PRICE_TOKENS = [NEAR_TOKEN, USDT_TOKEN];

export function registerPortfolioView(app: FastifyInstance, store: CollectorStore): void {
  const context = async () => {
    const [snapshot, markets, tokens] = await Promise.all([
      store.latestSnapshot(),
      store.markets(),
      store.tokenMetadata(),
    ]);
    const summary = (snapshot?.summary ?? {}) as {
      prices?: { token: string; usd: string; quality: string }[];
    };
    const prices = new Map(
      (summary.prices ?? [])
        .filter((x) => PRICE_TOKENS.includes(x.token) || x.quality === 'OK')
        .map((x) => [x.token, Number(x.usd)] as const),
    );
    return {
      prices,
      markets: markets.map((m) => ({ ...(m.latest as LoopMarket), token: m.token })),
      symbols: new Map(tokens.map((t) => [t.token, t.symbol])),
    };
  };

  app.get('/v1/analytics/portfolio/:id', async (req, reply) => {
    const parsed = z.object({ id: z.enum(['demo-500', 'demo-5000']) }).safeParse(req.params);
    if (!parsed.success) return reply.code(404).send({ error: 'unknown portfolio' });
    const [ctx, [analysis], current] = await Promise.all([
      context(),
      store.analysesOf(parsed.data.id, 1),
      new DemoLedgerStore(store.db).current(parsed.data.id),
    ]);
    return buildPortfolioView({ id: parsed.data.id, analysis: analysis ?? null, ...ctx, current });
  });

  /**
   * The agent's decisions, newest first, in plain words. Consecutive analyses that reached the same conclusion for
   * the same reasons are folded into one entry with a count and a time range, so a quiet day reads as one line.
   */
  app.get('/v1/analytics/agent-activity', async (req) => {
    const q = z
      .object({
        portfolio: z.enum(['demo-500', 'demo-5000']).default('demo-5000'),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);
    const [ctx, rows] = await Promise.all([context(), store.analysesOf(q.portfolio, q.limit)]);
    const verdicts = await store.verdictsOfRuns(rows.flatMap((r) => (r.runId ? [r.runId] : [])));
    const entries: {
      from: string;
      to: string;
      count: number;
      headline: string;
      notes: string[];
      policy: { verdict: string; sentence: string }[];
      key: string;
    }[] = [];
    for (const r of rows) {
      const n = narrate(r.result as AnalysisResult, ctx.symbols);
      const policy = verdicts
        .filter((v) => v.runId === r.runId)
        .map((v) => ({
          verdict: v.verdict,
          sentence:
            v.verdict === 'ALLOW'
              ? 'The safety policy allowed it (all 12 checks passed). In shadow mode it was only simulated: nothing was sent.'
              : `The safety policy blocked it: ${v.violations.map((x) => x.message).join('; ') || 'a check failed'}.`,
        }));
      // fold on the meaning, not on the exact numbers inside the sentences
      const key = [
        n.headline,
        ...n.notes.map((x) => x.replace(/[\d.,$−]+/g, '#')),
        ...policy.map((p) => p.verdict),
      ].join('|');
      const last = entries[entries.length - 1];
      const at = r.createdAt.toISOString();
      if (last && last.key === key) {
        last.count += 1;
        last.from = at;
      } else
        entries.push({
          from: at,
          to: at,
          count: 1,
          headline: n.headline,
          notes: n.notes,
          policy,
          key,
        });
    }
    // The user's own requests from the dashboard, one entry each, merged in by time.
    const byRequest = new Map<
      string,
      { at: Date; type: string; payload: Record<string, unknown> }[]
    >();
    for (const ev of await store.requestEvents(q.portfolio, 200)) {
      const rid = ev.runId ?? '';
      byRequest.set(rid, [
        ...(byRequest.get(rid) ?? []),
        { at: ev.at, type: ev.type, payload: (ev.payload ?? {}) as Record<string, unknown> },
      ]);
    }
    for (const evs of byRequest.values()) {
      const ask = evs.find((e) => e.type === 'operator.request');
      const end = evs.find((e) => e.type !== 'operator.request');
      const p = ask?.payload ?? {};
      const token = String(p['token']);
      const what =
        p['kind'] === 'lending.repay'
          ? `repay $${String(p['usd'])} of the loan`
          : `deposit $${String(p['usd'])} of ${token === NEAR_TOKEN ? 'wNEAR' : (ctx.symbols.get(token) ?? token)} into Burrow`;
      const outcome = typeof p['outcome'] === 'string' ? p['outcome'] : '';
      const result = end?.payload ?? {};
      const at = (end ?? ask ?? evs[0])?.at.toISOString() ?? new Date(0).toISOString();
      const policyNote =
        outcome === 'approve'
          ? 'The safety policy allowed it (all 12 checks passed).'
          : outcome === 'require_approval'
            ? `The safety policy asked for your confirmation${result['confirmedBy'] ? ', and you confirmed it' : ''}.`
            : outcome === 'reject'
              ? 'The safety policy blocked it. Nothing was done.'
              : '';
      const resultNote =
        end?.type === 'operator.request.result'
          ? result['status'] === 'dry_run'
            ? 'It ran as a dry run: simulated, nothing was signed or sent.'
            : `The executor answered: ${String(result['status'])}.`
          : end?.type === 'operator.request.failed'
            ? typeof result['sentence'] === 'string'
              ? result['sentence']
              : 'It failed.'
            : outcome === 'require_approval'
              ? 'Not confirmed (it expired or is still waiting).'
              : '';
      entries.push({
        from: at,
        to: at,
        count: 1,
        headline: ask ? `You asked the agent to ${what}` : 'A request from the dashboard',
        notes: [policyNote, resultNote].filter(Boolean),
        policy: [],
        key: `request|${at}`,
      });
    }
    entries.sort((x, y) => (x.to < y.to ? 1 : -1));
    return {
      portfolio: q.portfolio,
      simulated: true,
      entries: entries.map(({ key: _key, ...e }) => e),
    };
  });
}
