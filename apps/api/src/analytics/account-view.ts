import { accountIdSchema, type AccountId, type TokenId } from '@near-autopilot/core';
import { BurrowClient } from '@near-autopilot/burrow-adapter';
import {
  NearAccountReader,
  NearContractViewer,
  NearTokenReader,
  type NearRpcClient,
} from '@near-autopilot/near-adapter';
import { orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import { RheaSwapQuoter, StaticPoolRegistry } from '@near-autopilot/rhea-adapter';
import {
  RheaDclClient,
  dclPositionAmounts,
  type DclPool,
  type DclPosition,
} from '@near-autopilot/rhea-dcl-adapter';
import type { FastifyInstance } from 'fastify';
import type { CollectorStore } from '../collector/store';
import { valueAccount, type AccountReads, type TokenFacts } from './account';
import { loopStrategies, type LoopMarket } from './looping';
import { hurdle, money, type PortfolioAction } from './portfolio-view';
import { consensus } from './series';

/**
 * YOUR ACCOUNT, read-only: any mainnet account id -> what it holds, how safe its Burrow loan is, and what could be done
 * with the idle tokens, costed the same way as the demo portfolios (a real Rhea quote for the swap). Only VIEW calls:
 * view_account, ft_balance_of, Burrow get_account / get_assets, Rhea get_return. Nothing is signed or sent, and the
 * account is not stored: the answer is computed per request (cached for 60 s).
 */
export interface MainnetReadDeps {
  readonly rpc: NearRpcClient;
  readonly burrowId: AccountId;
  readonly rheaId: AccountId;
  /** The allowlisted Rhea pools (config.rhea.pools): the only swaps an action may assume. */
  readonly pools: readonly { poolId: number; tokenA: TokenId; tokenB: TokenId }[];
  /** Rhea DCL (concentrated liquidity) contract, for reading the account's LP positions. Null disables that read. */
  readonly dclId?: AccountId | null;
}

interface DclPositionView {
  readonly lptId: string;
  readonly poolId: string;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly symbolX: string;
  readonly symbolY: string;
  readonly amountX: number;
  readonly amountY: number;
  readonly usd: number | null;
  readonly range: { readonly left: number; readonly right: number };
}

/**
 * The account's Rhea DCL (concentrated-liquidity) LP positions, valued at the latest prices. Read-only: `list_liquidities`
 * for the positions and `get_pool` for each pool's current point, then the exact token amounts (dclPositionAmounts).
 * USD is a calculated estimate from on-chain liquidity + current point + market prices.
 */
async function readDclPositions(
  dcl: RheaDclClient,
  accountId: AccountId,
  tokenMeta: ReadonlyMap<string, { symbol: string; decimals: number }>,
  prices: ReadonlyMap<string, number>,
): Promise<DclPositionView[]> {
  const positions: DclPosition[] = await dcl.listPositions(accountId).catch(() => []);
  if (positions.length === 0) return [];
  const pools = new Map<string, DclPool>();
  await Promise.all(
    [...new Set(positions.map((p) => p.pool_id))].map(async (pid) => {
      const p = await dcl.getPool(pid).catch(() => null);
      if (p) pools.set(pid, p);
    }),
  );
  const out: DclPositionView[] = [];
  for (const pos of positions) {
    const pool = pools.get(pos.pool_id);
    if (!pool || pos.amount <= 0n) continue;
    const { x, y } = dclPositionAmounts(pos, pool.current_point);
    const fx = tokenMeta.get(pool.token_x);
    const fy = tokenMeta.get(pool.token_y);
    const amountX = Number(x) / 10 ** (fx?.decimals ?? 24);
    const amountY = Number(y) / 10 ** (fy?.decimals ?? 24);
    const px = prices.get(pool.token_x) ?? null;
    const py = prices.get(pool.token_y) ?? null;
    out.push({
      lptId: pos.lpt_id,
      poolId: pos.pool_id,
      tokenX: pool.token_x,
      tokenY: pool.token_y,
      symbolX: fx?.symbol ?? pool.token_x.slice(0, 10),
      symbolY: fy?.symbol ?? pool.token_y.slice(0, 10),
      amountX,
      amountY,
      usd: px !== null && py !== null ? amountX * px + amountY * py : null,
      range: { left: pos.left_point, right: pos.right_point },
    });
  }
  return out;
}

const ORCH = orchestratorConfigSchema.parse({});
const GAS = ORCH.swap.estimatedGasUsd;
const HORIZON = ORCH.swap.horizonDays;
const H = HORIZON / 365;
const WNEAR = 'wrap.near' as TokenId;
/** Native NEAR left untouched for gas and storage when proposing to use the rest. */
const NEAR_RESERVE = 1;

export function registerAccountView(
  app: FastifyInstance,
  store: CollectorStore,
  deps: MainnetReadDeps,
): void {
  const viewer = new NearContractViewer(deps.rpc);
  const tokens = new NearTokenReader(viewer);
  const native = new NearAccountReader(deps.rpc);
  const burrow = new BurrowClient(viewer, deps.burrowId);
  const quoter = new RheaSwapQuoter(viewer, {
    contractId: deps.rheaId,
    pools: new StaticPoolRegistry(deps.pools),
  });
  const dcl = deps.dclId ? new RheaDclClient(viewer, { contractId: deps.dclId }) : null;
  const cache = new Map<string, { at: number; body: unknown }>();

  /** Confirmed prices of the latest snapshot: the median of the valid USD quotes per token. */
  const latestPrices = async () => {
    const snap = await store.latestSnapshot();
    if (!snap) return new Map<string, number>();
    const obs = await store.pricesForSnapshot(snap.id);
    const by = new Map<string, typeof obs>();
    for (const o of obs) by.set(o.asset, [...(by.get(o.asset) ?? []), o]);
    const out = new Map<string, number>();
    for (const [asset, list] of by) {
      const c = consensus(list);
      if (c.price !== null) out.set(asset === 'wrap.testnet' ? WNEAR : asset, c.price);
    }
    // curated assets are keyed by their testnet id in the observations; map the mainnet ids too
    const summary = (snap.summary ?? {}) as {
      prices?: { token: string; usd: string; quality: string }[];
    };
    for (const p of summary.prices ?? []) if (p.quality === 'OK') out.set(p.token, Number(p.usd));
    return out;
  };

  app.get('/v1/analytics/account/:id', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    const id = parsed.data;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.body;

    let nativeYocto: bigint;
    try {
      nativeYocto = await native.getNativeBalance(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(/does not exist|UNKNOWN_ACCOUNT/i.test(msg) ? 404 : 502).send({
        error: /does not exist|UNKNOWN_ACCOUNT/i.test(msg)
          ? `account ${id} does not exist on NEAR mainnet`
          : `could not read the account: ${msg}`,
      });
    }
    const [assets, markets, meta, prices, account] = await Promise.all([
      burrow.listAssets(),
      store.markets(),
      store.tokenMetadata(),
      latestPrices(),
      burrow.getAccount(id).catch(() => null),
    ]);
    // Wallet balances of every token Burrow lists (the tokens an action could use), read in parallel.
    const wallet = new Map<TokenId, bigint>();
    await Promise.all(
      assets.map(async (a) => {
        const raw = await tokens.getBalance(a.tokenId, id).catch(() => 0n);
        if (raw > 0n) wallet.set(a.tokenId, raw);
      }),
    );
    const symbol = new Map(meta.map((m) => [m.token, m] as const));
    const facts = new Map<string, TokenFacts>();
    for (const a of assets) {
      const m = symbol.get(a.tokenId);
      facts.set(a.tokenId, {
        decimals: m?.decimals ?? (a.tokenId === WNEAR ? 24 : 18),
        symbol: m?.symbol ?? a.tokenId.slice(0, 10),
        usd: prices.get(a.tokenId) ?? null,
        extraDecimals: a.extraDecimals,
        vr: a.volatilityRatioBps / 10_000,
      });
    }
    const reads: AccountReads = {
      accountId: id,
      nativeYocto,
      wallet,
      burrow: account && {
        supplied: account.supplied.map((x) => ({ token: x.tokenId, inner: x.inner })),
        collateral: account.collateral.map((x) => ({ token: x.tokenId, inner: x.inner })),
        borrowed: account.borrowed.map((x) => ({ token: x.tokenId, inner: x.inner })),
      },
    };
    const v = valueAccount(reads, facts);
    const market = (t: string) =>
      markets.find((m) => m.token === t)?.latest as (LoopMarket & { status?: string }) | undefined;
    const rate = (t: string, f: 'netSupplyApr' | 'borrowApr') => {
      const m = market(t);
      const x = m?.status === 'OK' ? (m[f] ?? (f === 'netSupplyApr' ? m.supplyApr : null)) : null;
      return x === null || x === undefined ? null : Number(x);
    };
    const sym = (t: string) => facts.get(t)?.symbol ?? t;
    const actions: PortfolioAction[] = [];
    const add = (
      a: Omit<PortfolioAction, 'netUsd' | 'netAprOnCapital' | 'horizonDays' | 'autopilot'> & {
        autopilot?: PortfolioAction['autopilot'];
      },
    ) => {
      if (a.grossUsd === null || a.capitalUsd <= 0) return;
      const cost = a.costs.reduce((s, c) => s + c.usd, 0);
      const net = a.grossUsd - cost;
      actions.push({
        ...a,
        horizonDays: HORIZON,
        netUsd: net,
        netAprOnCapital: (net / a.capitalUsd) * (365 / HORIZON),
        autopilot: a.autopilot ?? hurdle(net, a.grossUsd, cost),
      });
    };
    const walletHoldings = v.holdings.filter(
      (h) => h.where === 'wallet' && h.usd !== null && h.usd >= 1,
    );
    // 1. repay a loan with the same token sitting idle in the wallet
    for (const debt of v.holdings.filter((h) => h.where === 'borrowed' && h.usd !== null)) {
      const idle = walletHoldings.find((w) => w.token === debt.token);
      const b = rate(debt.token, 'borrowApr');
      if (!idle?.usd || !debt.usd || b === null) continue;
      const repay = Math.min(idle.usd, debt.usd);
      add({
        id: `repay-${debt.token}`,
        kind: 'keep',
        title: `Repay ${money(repay)} of your ${debt.symbol} loan`,
        summary: `The loan costs ${(b * 100).toFixed(1)}% a year and you hold idle ${debt.symbol} in the wallet. Repaying saves that interest and makes the loan safer.`,
        capitalUsd: repay,
        grossUsd: repay * b * H,
        costs: [{ label: 'Network fee (gas)', usd: GAS }],
        risk: 'low',
        steps: [`Repay ${money(repay)} ${debt.symbol} on Burrow.`],
        risks: ['You no longer have this amount at hand.'],
        basis: `Interest saved at today's ${debt.symbol} borrow rate for ${HORIZON} days.`,
      });
    }
    // 2. lend each idle token Burrow accepts (native NEAR as wNEAR, keeping a reserve for gas)
    for (const w of walletHoldings) {
      const token = w.token === 'near' ? WNEAR : w.token;
      const s = rate(token, 'netSupplyApr');
      const usdPer = w.usd !== null && w.amount > 0 ? w.usd / w.amount : 0;
      const capital =
        w.token === 'near' ? Math.max(0, (w.amount - NEAR_RESERVE) * usdPer) : (w.usd ?? 0);
      if (s === null || s <= 0 || capital < 1) continue;
      add({
        id: `lend-${w.token}`,
        kind: 'lend',
        title: `Lend your idle ${w.symbol} on Burrow`,
        summary: `Deposit it and earn the ${(s * 100).toFixed(2)}% supply rate.${w.token === 'near' ? ` ${NEAR_RESERVE} NEAR stays in the wallet for fees.` : ''}`,
        capitalUsd: capital,
        grossUsd: capital * s * H,
        costs: [
          {
            label:
              w.token === 'near'
                ? 'Network fees (wrap, deposit, withdraw)'
                : 'Network fees (deposit, withdraw)',
            usd: (w.token === 'near' ? 3 : 2) * GAS,
          },
        ],
        risk: 'low',
        steps: [
          ...(w.token === 'near' ? ['Wrap NEAR to wNEAR.'] : []),
          `Deposit ${money(capital)} of ${w.symbol} into Burrow.`,
        ],
        risks: [
          'Variable rate; withdrawals can wait when almost everything is borrowed.',
          'Smart-contract risk.',
        ],
        basis: `Today's supply rate for ${HORIZON} days, not compounded.`,
      });
    }
    // 3. swap idle NEAR into a stablecoin through the allowlisted pool, with a REAL quote, and lend it
    const nearIdle = walletHoldings.filter((w) => w.token === 'near' || w.token === WNEAR);
    const nearUsdPrice = prices.get(WNEAR) ?? null;
    for (const pool of deps.pools) {
      const stable =
        pool.tokenA === WNEAR ? pool.tokenB : pool.tokenB === WNEAR ? pool.tokenA : null;
      const s = stable ? rate(stable, 'netSupplyApr') : null;
      const f = stable ? facts.get(stable) : undefined;
      const nearAmount = nearIdle.reduce(
        (a, w) => a + (w.token === 'near' ? Math.max(0, w.amount - NEAR_RESERVE) : w.amount),
        0,
      );
      if (!stable || s === null || !f?.usd || nearUsdPrice === null || nearAmount < 1) continue;
      const amountIn = BigInt(Math.floor(nearAmount * 1e6)) * 10n ** 18n;
      const q = await quoter
        .quote({ tokenIn: WNEAR, tokenOut: stable, amountIn })
        .catch(() => null);
      if (!q) continue;
      const inUsd = nearAmount * nearUsdPrice;
      const outUsd =
        (Number(q.amountOut / 10n ** BigInt(Math.max(0, f.decimals - 6))) / 1e6) * f.usd;
      add({
        id: `swap-lend-${stable}`,
        kind: 'lend',
        title: `Swap idle NEAR to ${sym(stable)} and lend it`,
        summary: `${sym(stable)} earns ${(s * 100).toFixed(2)}% on Burrow; the swap price is a live Rhea quote.`,
        capitalUsd: inUsd,
        grossUsd: outUsd * s * H,
        costs: [
          {
            label: `Swap cost (live quote, pool #${pool.poolId})`,
            usd: Math.max(0, inUsd - outUsd),
          },
          { label: 'Network fees (wrap, swap, deposit, withdraw)', usd: 4 * GAS },
        ],
        risk: 'low',
        steps: [
          'Wrap NEAR to wNEAR.',
          `Swap ${nearAmount.toFixed(2)} wNEAR to ${sym(stable)} on Rhea (pool #${pool.poolId}).`,
          `Deposit into Burrow.`,
        ],
        risks: [
          'You give up NEAR price exposure on this part.',
          'Stablecoin peg risk; variable rate.',
        ],
        basis: "Live Rhea get_return quote vs the confirmed NEAR price; today's supply rate.",
      });
    }
    // 4. loops on the largest idle holding, for comparison only
    const biggest = [...walletHoldings].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
    if (biggest?.usd)
      for (const l of loopStrategies(
        markets
          .filter((m) => m.token === (biggest.token === 'near' ? WNEAR : biggest.token))
          .map((m) => ({ ...(m.latest as LoopMarket), token: m.token })),
        {
          equityUsd: biggest.usd,
          targetHealthFactor: ORCH.risk.targetHealthFactorBps / 10_000,
          gasUsdPerTx: GAS,
          horizonDays: HORIZON,
        },
      ))
        // Shown for comparison only when it would actually earn after every cost (on a small amount the
        // network fees of the rounds alone exceed the interest, so it would only be a loss on display).
        if (l.netUsd > 0)
          add({
            id: `loop-${l.token}`,
            kind: 'loop',
            title: `Loop ${sym(l.token)} on Burrow (${l.leverage.toFixed(1)}× leverage)`,
            summary: `Deposit, borrow the same token, deposit again (${l.rounds} rounds): supply rate on ${money(l.depositedUsd)}, borrow rate on ${money(l.borrowedUsd)}.`,
            capitalUsd: l.equityUsd,
            grossUsd: l.grossUsd,
            costs: [
              { label: `Interest on ${money(l.borrowedUsd)} borrowed`, usd: l.borrowCostUsd },
              { label: 'Network fees (every round in and out)', usd: l.gasUsd },
            ],
            risk: 'high',
            steps: [
              `End state: ${money(l.depositedUsd)} deposited, ${money(l.borrowedUsd)} borrowed, health factor ${l.targetHealthFactor}.`,
            ],
            risks: [
              `Loses money above a ${(l.breakEvenBorrowApr * 100).toFixed(1)}% borrow rate.`,
              'Leverage multiplies rate and smart-contract risk.',
            ],
            basis:
              "Exact leverage from Burrow's health factor for the same token on both sides; today's rates.",
            autopilot: {
              verdict: 'not_allowed',
              sentence: 'The autopilot will not do this: it never borrows. Shown for comparison.',
            },
          });
    actions.sort((a, b) => (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity));

    // What the current Burrow position earns or costs per month at today's rates (deposits earn, loans cost).
    let monthly = 0;
    const noRate: string[] = [];
    for (const h of v.holdings) {
      // dust (under $1) in dead markets would only block the figure; larger positions without a rate are named
      if (h.where === 'wallet' || h.usd === null || h.usd < 1) continue;
      const r = rate(h.token, h.where === 'borrowed' ? 'borrowApr' : 'netSupplyApr');
      if (r === null) noRate.push(h.symbol);
      else monthly += (h.where === 'borrowed' ? -1 : 1) * h.usd * r * H;
    }
    const hasPosition = v.holdings.some((h) => h.where !== 'wallet');
    const dclPositions = dcl ? await readDclPositions(dcl, id, symbol, prices) : [];

    const body = {
      earnings: {
        monthlyNetUsd: hasPosition ? monthly : 0,
        sentence: !hasPosition
          ? 'Nothing is deposited on Burrow: the tokens in the wallet earn nothing.'
          : (monthly >= 0
              ? `Your Burrow position earns about ${money(monthly)} a month at today's rates.`
              : `Your Burrow position costs about ${money(-monthly)} a month: the loan interest is higher than what the deposits earn.`) +
            (noRate.length ? ` Not counted (no current rate): ${noRate.join(', ')}.` : ''),
      },
      accountId: id,
      network: 'mainnet',
      readOnly: true,
      asOf: new Date().toISOString(),
      holdings: v.holdings,
      unpriced: v.unpriced,
      totals: v.totals,
      dclPositions,
      loan: v.loan,
      health: !v.loan.hasDebt
        ? {
            level: 'low',
            label: 'No loan',
            sentence: 'Nothing is borrowed: there is nothing to liquidate.',
          }
        : v.loan.healthFactor === null
          ? {
              level: 'high',
              label: 'Unknown',
              sentence: 'The loan could not be valued: a price or a risk parameter is missing.',
            }
          : {
              level:
                v.loan.healthFactor >= 1.5 ? 'low' : v.loan.healthFactor >= 1.1 ? 'medium' : 'high',
              label:
                v.loan.healthFactor >= 1.5
                  ? 'Safe'
                  : v.loan.healthFactor >= 1.1
                    ? 'Needs watching'
                    : 'At risk',
              sentence:
                v.loan.collateralDropToLiquidation !== null
                  ? `Health factor ${v.loan.healthFactor.toFixed(2)}: the loan stays safe unless your collateral loses ${(v.loan.collateralDropToLiquidation * 100).toFixed(0)}% of its value.`
                  : 'The loan can be liquidated now.',
            },
      actions,
    };
    cache.set(id, { at: Date.now(), body });
    return body;
  });
}
