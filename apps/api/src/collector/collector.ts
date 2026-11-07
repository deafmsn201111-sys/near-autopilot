import { BurrowClient, type BurrowAsset } from '@near-autopilot/burrow-adapter';
import type { ApiEnv } from '@near-autopilot/config';
import {
  accountIdSchema,
  errorMessage,
  toJsonSafe,
  type AccountId,
  type ContractViewer,
  type Logger,
} from '@near-autopilot/core';
import { NearTokenReader, type NearRpcClient } from '@near-autopilot/near-adapter';
import type { CycleReport } from '@near-autopilot/orchestrator';
import type { AutopilotConfig } from '../autopilot-config';
import { MAINNET_ASSETS } from '../market-data/assets';
import { formatDecimal } from '../market-data/decimal';
import type { HttpJsonClient } from '../market-data/http';
import {
  usable,
  type MarketDataProvider,
  type MarketReport,
  type PriceObservation,
} from '../market-data/model';
import type { AutopilotRepository } from '../repository';
import { DEMO_PORTFOLIOS, demoAssets, type DemoPortfolioId } from '../simulation/demo-portfolios';
import { wire } from '../wiring';
import type { YieldLimits } from '../yield/burrow';
import { fromRaw, mul, toWad, truncate } from '../yield/math';
import type { BlockRef, YieldReport } from '../yield/model';
import { finalBlock, PinnedViewer } from '../yield/pinned-viewer';
import type { YieldService } from '../yield/service';
import { burrowMarkets, compareStrategies, type BurrowMarketView } from './analysis';
import {
  feeWindow,
  volumeUsdBetween,
  WINDOWS,
  type FeeWindow,
  type PoolPoint,
  type WindowName,
} from './history';
import { simulateLpEntry, swapCostUsd, type LpSimResult } from './lp';
import type {
  CollectorFilter,
  DiscoveredPool,
  PoolClassification,
  SourceRun,
  TokenPrice,
} from './model';
import { curatedPrices, longTailPrices } from './prices';
import { classifyPool, readDclPool, readV1Pool, scanDclPools, scanV1Pools } from './rhea-discovery';
import type { CollectorStore } from './store';
import { chainOf } from '../evidence/chain';
import { PgControlStore, PgIdempotencyStore } from '../infra/orchestrator-stores';

/** Re-read the curated prices before the portfolio analysis when the cycle's own are older than this. */
const REFRESH_PRICES_AFTER_MS = 60_000;

export interface CollectorDeps {
  readonly env: ApiEnv;
  readonly config: AutopilotConfig;
  /** Read-only MAINNET RPC (chain id checked by the caller). View calls only. */
  readonly rpc: Pick<NearRpcClient, 'call'>;
  readonly market: MarketDataProvider;
  readonly yields: YieldService;
  readonly http: HttpJsonClient;
  readonly store: CollectorStore;
  readonly repo: AutopilotRepository;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly ids: () => string;
  readonly filter: CollectorFilter;
  readonly limits: YieldLimits;
  /** Full registry rescan every N cycles (and whenever the registry is empty). */
  readonly registryEvery: number;
  /** ...and whenever the last completed scan is older than this (e.g. after downtime). */
  readonly registryMaxAgeSeconds: number;
  readonly portfolios: readonly DemoPortfolioId[];
  readonly horizonDays: number;
  readonly gasUsdPerTx: number;
  readonly dclContract: AccountId | null;
  /** Shadow Gateway reference probe (Rhea vs NEAR Intents dry quotes), on this cycle's prices and pinned block. */
  readonly routeProbe?: (
    market: MarketReport,
    viewer: ContractViewer,
    rpc: Pick<NearRpcClient, 'call'>,
  ) => Promise<{ records: number; detail: string; degraded: boolean }>;
}

/** A full registry rescan is due: none yet, every Nth cycle, or the last one is too old. */
export function registryScanDue(
  state: { cycles: number; lastAt: Date } | null,
  every: number,
  maxAgeSeconds: number,
  now: Date,
): boolean {
  if (state === null) return true;
  if (state.cycles + 1 >= every) return true;
  return now.getTime() - state.lastAt.getTime() >= maxAgeSeconds * 1000;
}

export interface CycleSummary {
  readonly id: string;
  readonly status: 'success' | 'partial' | 'failed' | 'skipped';
  readonly snapshotId: string | null;
  readonly records: number;
  readonly sources: readonly SourceRun[];
  readonly error: string | null;
}

const WINDOW_NAMES: readonly WindowName[] = ['1H', '24H', '7D', '30D', 'SINCE_FIRST'];
const fixed = <T>(value: T) => ({ report: async () => value, latest: () => value });

/**
 * One autonomous, READ-ONLY collection cycle over mainnet. No LLM, no signer: plain views, price APIs and arithmetic.
 * Every source runs isolated; a failing source is recorded and the cycle is `partial`, never silently patched.
 */
export class ShadowCollector {
  private running = false;
  private readonly decimals = new Map<string, number | null>();

  constructor(private readonly d: CollectorDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async runCycle(trigger: 'scheduled' | 'on_demand'): Promise<CycleSummary> {
    const id = this.d.ids();
    if (this.running)
      return {
        id,
        status: 'skipped',
        snapshotId: null,
        records: 0,
        sources: [],
        error: 'a cycle is running',
      };
    const startedAt = this.d.now();
    const registryScan = registryScanDue(
      await this.d.store.registryScanState(),
      this.d.registryEvery,
      this.d.registryMaxAgeSeconds,
      startedAt,
    );
    if (!(await this.d.store.startCycle(id, trigger, startedAt, registryScan)))
      return {
        id,
        status: 'skipped',
        snapshotId: null,
        records: 0,
        sources: [],
        error: 'another cycle is running',
      };
    this.running = true;
    const sources: SourceRun[] = [];
    let records = 0;
    let snapshotId: string | null = null;
    let error: string | null = null;
    const timed = async <T>(
      source: string,
      f: () => Promise<{ value: T; records: number; detail?: string | null; degraded?: boolean }>,
    ) => {
      const t0 = Date.now();
      try {
        const r = await f();
        records += r.records;
        sources.push({
          source,
          health: r.degraded ? 'degraded' : 'ok',
          detail: r.detail ?? null,
          records: r.records,
          durationMs: Date.now() - t0,
        });
        return r.value;
      } catch (e) {
        sources.push({
          source,
          health: 'unavailable',
          detail: errorMessage(e),
          records: 0,
          durationMs: Date.now() - t0,
        });
        this.d.logger.warn('collector source failed', { source, error: errorMessage(e) });
        return null;
      }
    };
    try {
      const block = await finalBlock(this.d.rpc);
      const viewer = new PinnedViewer(this.d.rpc, block);
      const tokens = new NearTokenReader(viewer);
      snapshotId = `${id}:s`;
      const now = this.d.now();

      // 1. Curated prices: Pyth (per feed) + DefiLlama + the NEAR exchange quorum (also persisted to market_prices).
      const market = await timed('prices.curated', async () => {
        const r = await this.d.market.report();
        const unusable = r.assets.filter((a) => !usable(a)).map((a) => a.referenceSymbol);
        return {
          value: r,
          records: r.assets.length,
          detail: [
            ...(unusable.length > 0 ? [`unpriced: ${unusable.join(', ')}`] : []),
            ...r.sources.map((s) => `${s.source}:${s.health}${s.detail ? ` (${s.detail})` : ''}`),
          ].join('; '),
          // Degraded when a curated asset has no usable price; one failing provider is only reported in the detail.
          degraded: unusable.length > 0,
        };
      });

      // 1b. Route probe: reference trades quoted on Rhea (pinned block) and 1Click (dry), best execution recorded.
      const probe = this.d.routeProbe;
      if (market && probe)
        await timed('routes.probe', async () => ({
          value: null,
          ...(await probe(market, viewer, this.d.rpc)),
        }));

      // 2. Burrow: every market at the pinned block.
      const burrowAssets = await timed('burrow', async () => {
        const a = await new BurrowClient(viewer, this.d.env.BURROW_CONTRACT_ID).listAssets();
        return { value: a, records: a.length };
      });

      // 3. Rhea: full registry scan (v1 + DCL) every N cycles, else re-read only the tracked pools.
      const pools = await timed(registryScan ? 'rhea.registry' : 'rhea.tracked', async () => {
        const p = registryScan ? await this.scan(viewer) : await this.reread(viewer);
        return { value: p, records: p.length };
      });

      // 4. Long-tail prices (DefiLlama near:<contract>) for every token that needs a value, decimals checked on-chain.
      const prices = new Map<string, TokenPrice>(market ? curatedPrices(market) : []);
      const priceObs: (PriceObservation & { asset: string })[] = market
        ? market.assets.flatMap((a) => a.observations.map((o) => ({ ...o, asset: a.testnetToken })))
        : [];
      const wanted = new Set<string>([
        ...(burrowAssets ?? []).map((a) => a.tokenId),
        ...(pools ?? []).filter((p) => p.reserves.every((r) => r > 0n)).flatMap((p) => p.tokens),
      ]);
      for (const t of prices.keys()) wanted.delete(t);
      await timed('prices.long_tail', async () => {
        const lt = await longTailPrices(
          this.d.http,
          this.d.env.DEFILLAMA_URL,
          [...wanted].sort(),
          now,
          undefined,
          this.d.now,
        );
        let mismatched = 0;
        for (const [t, p] of lt.prices) {
          const onChain = await this.decimalsOf(tokens, t);
          const reported = lt.reportedDecimals.get(t);
          if (onChain === null || (reported !== undefined && reported !== onChain)) {
            mismatched += 1;
            continue;
          }
          prices.set(t, p);
        }
        priceObs.push(...lt.observations.map((o) => ({ ...o, asset: o.contract ?? o.assetId })));
        return {
          value: null,
          records: lt.observations.length,
          detail: `${lt.prices.size} priced of ${wanted.size}; ${lt.failures} failed batch(es); ${mismatched} decimals mismatch`,
          degraded: lt.failures > 0,
        };
      });
      for (const t of prices.keys()) await this.decimalsOf(tokens, t);

      // 5. Classify, observe and store the pools; compute fee windows for tracked supported pools.
      const poolViews = pools
        ? await timed('rhea.analytics', async () => {
            const v = await this.storePools(
              pools,
              prices,
              block,
              snapshotId ?? '',
              registryScan,
              now,
              viewer,
            );
            return { value: v, records: v.length };
          })
        : null;

      // 6. Burrow markets (all) + observations.
      const markets = burrowAssets
        ? await timed('burrow.analytics', async () => {
            const m = await this.storeBurrow(burrowAssets, prices, block, snapshotId ?? '', now);
            return { value: m, records: m.length };
          })
        : null;

      // 7. The agents' yield report (configured pools, allowlist) at the SAME block, marked scheduled.
      const yieldReport = await timed('yields.agents', async () => {
        const r = await this.d.yields.reportAt(block, trigger);
        return {
          value: r,
          records: r.estimates.length,
          degraded: r.sources.some((s) => s.health === 'unavailable'),
        };
      });

      await this.d.store.insertPrices(snapshotId, priceObs);
      records += priceObs.length;
      await this.d.store.insertSnapshot({
        id: snapshotId,
        cycleId: id,
        network: 'mainnet',
        blockHeight: block.height,
        blockTimestamp: block.timestamp,
        takenAt: now,
        marketReportId: market?.id ?? null,
        yieldReportId: yieldReport?.id ?? null,
        summary: toJsonSafe({
          prices: [...prices]
            .filter(([t]) => MAINNET_ASSETS.some((a) => a.testnetToken === t))
            .map(([t, p]) => ({
              token: t,
              usd: formatDecimal(p.usd),
              quality: p.quality,
              source: p.source,
            })),
          pricedTokens: prices.size,
          pools: poolViews?.length ?? 0,
          markets: markets?.length ?? 0,
        }),
      });

      // 7b. Token metadata (symbol, decimals) for display: only tokens not stored yet, a bounded number per cycle.
      await timed('tokens.metadata', async () => {
        const known = new Set((await this.d.store.tokenMetadata()).map((t) => t.token));
        const missing = (await this.d.store.displayTokens(400)).filter((t) => !known.has(t));
        const batch = missing.slice(0, 300);
        const rows: Array<{
          token: string;
          symbol: string;
          decimals: number;
          blockHeight: number;
          fetchedAt: Date;
        }> = [];
        let failed = 0;
        for (const t of batch) {
          const id = accountIdSchema.safeParse(t);
          if (!id.success) {
            failed += 1;
            continue;
          }
          try {
            const m = await tokens.getMetadata(id.data);
            rows.push({
              token: t,
              symbol: m.symbol.slice(0, 64),
              decimals: m.decimals,
              blockHeight: block.height,
              fetchedAt: now,
            });
          } catch {
            failed += 1; // no or malformed ft_metadata: the dashboard shows the contract id
          }
        }
        await this.d.store.upsertTokenMetadata(rows);
        return {
          value: null,
          records: rows.length,
          detail: `${rows.length} new, ${failed} without readable metadata, ${missing.length - batch.length} left for later cycles`,
        };
      });

      // 8. Both demo portfolios on this one snapshot. A long cycle (a registry scan on a rate-limited public RPC takes
      // minutes) would hand the agents prices older than the 180 s freshness limit, and every decision would be
      // skipped as stale. The limit stays: the curated prices are re-read right before the analysis instead, when
      // the ones from the start of the cycle are older than REFRESH_PRICES_AFTER_MS.
      const pricesForAnalysis =
        market && this.d.now().getTime() - market.fetchedAt.getTime() > REFRESH_PRICES_AFTER_MS
          ? await timed('prices.refresh', async () => {
              const r = await this.d.market.report();
              return {
                value: r,
                records: r.assets.length,
                detail: 'curated prices re-read for the portfolio analysis',
              };
            })
          : market;
      if (pricesForAnalysis && yieldReport && markets && poolViews)
        await timed('portfolios', async () => {
          for (const pid of this.d.portfolios)
            await this.analysePortfolio(
              pid,
              snapshotId ?? '',
              pricesForAnalysis,
              yieldReport,
              viewer,
              markets,
              poolViews,
              prices,
            );
          return { value: null, records: this.d.portfolios.length };
        });
    } catch (e) {
      error = errorMessage(e);
      this.d.logger.error('collector cycle failed', { error });
    }
    const finishedAt = this.d.now();
    const status = error
      ? 'failed'
      : sources.some((s) => s.health !== 'ok')
        ? 'partial'
        : 'success';
    try {
      await this.d.store.finishCycle(id, {
        status,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        records,
        sources,
        error,
        snapshotId: error ? null : snapshotId,
      });
    } finally {
      this.running = false;
    }
    this.d.logger.info('collector cycle finished', {
      id,
      status,
      records,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    return { id, status, snapshotId, records, sources, error };
  }

  private async decimalsOf(tokens: NearTokenReader, token: string): Promise<number | null> {
    if (this.decimals.has(token)) return this.decimals.get(token) ?? null;
    let d: number | null = null;
    try {
      d = (await tokens.getMetadata(accountIdSchema.parse(token))).decimals;
    } catch {
      d = null;
    }
    this.decimals.set(token, d);
    return d;
  }

  private async scan(viewer: PinnedViewer): Promise<DiscoveredPool[]> {
    const v1 = await scanV1Pools(viewer, this.d.env.RHEA_CONTRACT_ID);
    const dcl = this.d.dclContract ? await scanDclPools(viewer, this.d.dclContract) : [];
    // Tracked v1 SIMPLE pools also need their cumulative volumes in a scan cycle.
    const tracked = new Set((await this.d.store.trackedPools()).map((p) => p.poolKey));
    const out: DiscoveredPool[] = [];
    for (const p of [...v1, ...dcl]) {
      if (tracked.has(p.poolKey) && p.family === 'v1' && p.poolType === 'SIMPLE_POOL') {
        out.push(await readV1Pool(viewer, this.d.env.RHEA_CONTRACT_ID, Number(p.raw.poolId)));
      } else out.push(p);
    }
    await this.d.store.markMissingInactive(
      'v1',
      v1.map((p) => p.poolKey),
      this.d.now(),
    );
    if (this.d.dclContract)
      await this.d.store.markMissingInactive(
        'dcl',
        dcl.map((p) => p.poolKey),
        this.d.now(),
      );
    return out;
  }

  private async reread(viewer: PinnedViewer): Promise<DiscoveredPool[]> {
    const out: DiscoveredPool[] = [];
    for (const row of await this.d.store.trackedPools()) {
      if (row.family === 'v1')
        out.push(
          await readV1Pool(viewer, this.d.env.RHEA_CONTRACT_ID, Number(row.poolKey.slice(3))),
        );
      else if (this.d.dclContract) {
        const p = await readDclPool(viewer, this.d.dclContract, row.poolKey.slice(4));
        if (p) out.push(p);
      }
    }
    return out;
  }

  /** Classify every pool, store observations for tracked ones (with a sequence check), compute fee windows. */
  private async storePools(
    pools: readonly DiscoveredPool[],
    prices: ReadonlyMap<string, TokenPrice>,
    block: BlockRef,
    snapshotId: string,
    registryScan: boolean,
    now: Date,
    viewer: PinnedViewer,
  ): Promise<PoolView[]> {
    const views: PoolView[] = [];
    const obsRows = [];
    const existing = new Map((await this.d.store.trackedPools()).map((p) => [p.poolKey, p]));
    // History is whatever is stored, not the current category: a pool demoted for a cycle keeps its fee history.
    const withHistory = await this.d.store.poolsWithHistory();
    const metadataAdmin = await this.adminFeeBps(viewer);
    for (const pool of pools) {
      // History exists only for pools tracked before: no per-pool queries for the thousands of untracked ones.
      const known = withHistory.has(pool.poolKey);
      const previous = known ? await this.d.store.lastPoolPoint(pool.poolKey) : null;
      // Fee history starts at the first reading WITH cumulative volumes (a registry-scan reading has none).
      const previousWithVolumes = previous?.volumesIn
        ? previous
        : known
          ? await this.d.store.lastPoolPoint(pool.poolKey, true)
          : null;
      const first = previousWithVolumes
        ? await this.d.store.poolPointAtOrBefore(pool.poolKey, null)
        : null;
      const historySeconds = first
        ? Math.round((block.timestamp.getTime() - first.at.getTime()) / 1000)
        : 0;
      // Volume over the stored history (needed for LP eligibility), from the first point to this reading.
      const windowVolumeUsd =
        first && pool.volumesIn
          ? volumeUsdBetween(
              first,
              this.point(pool, block, null, metadataAdmin),
              pool.tokens,
              this.decimals,
              prices,
            )
          : null;
      const c = classifyPool({
        pool,
        decimals: this.decimals,
        prices,
        filter: this.d.filter,
        historySeconds,
        windowVolumeUsd,
      });
      const tracked = c.tracked || existing.has(pool.poolKey);
      let quality = 'OK';
      if (tracked && previous) {
        const regress =
          previous.blockHeight >= block.height ||
          (pool.volumesIn &&
            previousWithVolumes?.volumesIn &&
            pool.volumesIn.some((v, i) => v < BigInt(previousWithVolumes.volumesIn?.[i] ?? '0')));
        if (regress) quality = 'DATA_INVALID';
      }
      if (tracked)
        obsRows.push({
          id: `${pool.poolKey}@${block.height}`,
          snapshotId,
          poolKey: pool.poolKey,
          blockHeight: block.height,
          blockTimestamp: block.timestamp,
          reserves: pool.reserves.map(String),
          volumesIn: pool.volumesIn ? pool.volumesIn.map(String) : null,
          feeBps: pool.feeBps,
          adminFeeBps: pool.family === 'v1' ? metadataAdmin : null,
          tvlUsd: c.tvlUsd ? formatDecimal(truncate(c.tvlUsd)) : null,
          priceQuality: c.priceQuality,
          quality,
          raw: { ...pool.raw },
        });
      views.push({ pool, c, tracked, windows: [], historySeconds });
    }
    await this.d.store.insertPoolObservations(obsRows);
    // Fee windows for tracked supported pools (now that this cycle's observation is stored).
    for (const v of views) {
      if (!v.tracked || v.c.modelStatus !== 'SUPPORTED' || !v.pool.volumesIn) continue;
      const end = this.point(
        v.pool,
        block,
        v.c.tvlUsd ? formatDecimal(v.c.tvlUsd) : null,
        metadataAdmin,
      );
      for (const name of WINDOW_NAMES) {
        const before =
          name === 'SINCE_FIRST'
            ? null
            : new Date(block.timestamp.getTime() - WINDOWS[name] * 1000);
        const start = await this.d.store.poolPointAtOrBefore(v.pool.poolKey, before);
        const stats = start
          ? await this.d.store.windowStats(v.pool.poolKey, start.at, block.timestamp)
          : null;
        const w = start
          ? feeWindow(
              name,
              [start, end],
              v.pool.tokens,
              this.decimals,
              prices,
              now,
              3_600,
              stats?.broken ?? false,
            )
          : feeWindow(name, [end], v.pool.tokens, this.decimals, prices, now, 3_600);
        v.windows.push({ ...w, range: stats?.range ?? null });
      }
    }
    const rows = views
      .filter((v) => registryScan || v.tracked)
      .map((v) => ({
        poolKey: v.pool.poolKey,
        contract: v.pool.contract,
        family: v.pool.family,
        poolType: v.pool.poolType,
        tokens: [...v.pool.tokens],
        firstSeenAt: now,
        lastSeenAt: now,
        lastBlockHeight: block.height,
        feeBps: v.pool.feeBps,
        tvlUsd: v.c.tvlUsd ? formatDecimal(v.c.tvlUsd) : null,
        priceQuality: v.c.priceQuality,
        category: v.c.category,
        modelStatus: v.c.modelStatus,
        reasons: v.c.reasons.map((r) => ({ ...r })),
        active: true,
        latest: toJsonSafe({
          reserves: v.pool.reserves.map(String),
          tvlMethod: v.c.tvlMethod,
          tracked: v.tracked,
          historySeconds: v.historySeconds,
          windows: v.windows,
          decimals: v.pool.tokens.map((t) => this.decimals.get(t) ?? null),
          raw: v.pool.raw,
        }),
      }));
    await this.d.store.upsertPools(rows);
    return views;
  }

  private point(
    pool: DiscoveredPool,
    block: BlockRef,
    tvlUsd: string | null,
    admin: number | null,
  ): PoolPoint {
    return {
      blockHeight: block.height,
      at: block.timestamp,
      reserves: pool.reserves.map(String),
      volumesIn: pool.volumesIn ? pool.volumesIn.map(String) : null,
      feeBps: pool.feeBps,
      adminFeeBps: pool.family === 'v1' ? admin : null,
      tvlUsd,
    };
  }

  /** `admin_fee_bps` from the exchange's `metadata`, read at this cycle's block (null if unreadable: no fee APR). */
  private async adminFeeBps(viewer: PinnedViewer): Promise<number | null> {
    try {
      const raw = (await viewer.view(this.d.env.RHEA_CONTRACT_ID, 'metadata', {})) as {
        admin_fee_bps?: unknown;
      } | null;
      return raw && typeof raw.admin_fee_bps === 'number' ? raw.admin_fee_bps : null;
    } catch {
      return null;
    }
  }

  private async storeBurrow(
    assets: readonly BurrowAsset[],
    prices: ReadonlyMap<string, TokenPrice>,
    block: BlockRef,
    snapshotId: string,
    now: Date,
  ): Promise<BurrowMarketView[]> {
    const { markets } = burrowMarkets({
      contract: this.d.env.BURROW_CONTRACT_ID,
      assets,
      block,
      now,
      decimals: this.decimals,
      prices,
      allowlist: new Set(this.d.config.policy.allowedTokens),
      limits: this.d.limits,
    });
    await this.d.store.upsertBurrowMarkets(
      markets.map((m) => ({
        token: m.token,
        contract: this.d.env.BURROW_CONTRACT_ID,
        firstSeenAt: now,
        lastSeenAt: now,
        status: m.status,
        latest: toJsonSafe(m),
      })),
    );
    await this.d.store.insertBurrowObservations(
      markets.map((m) => ({
        id: `${m.token}@${block.height}`,
        snapshotId,
        token: m.token,
        blockHeight: block.height,
        blockTimestamp: block.timestamp,
        supplyApr: m.supplyApr,
        borrowApr: m.borrowApr,
        utilization: m.utilization,
        availableUsd: m.availableUsd,
        rewardApr: m.rewardApr,
        quality: m.status,
        raw: toJsonSafe(m),
      })),
    );
    return markets;
  }

  private async analysePortfolio(
    pid: DemoPortfolioId,
    snapshotId: string,
    market: MarketReport,
    yields: YieldReport,
    viewer: PinnedViewer,
    markets: readonly BurrowMarketView[],
    pools: readonly PoolView[],
    prices: ReadonlyMap<string, TokenPrice>,
  ): Promise<void> {
    const env: ApiEnv = { ...this.d.env, SIMULATION_PORTFOLIO: pid };
    let report: CycleReport | null = null;
    const wired = await wire(env, this.d.config, this.d.repo, this.d.logger, {
      shadowInputs: { market: fixed(market), yields: fixed(yields), viewer, rpc: this.d.rpc },
      onCycleReport: (r) => {
        report = r;
      },
      // Durable per-portfolio mode and idempotency (a read-only escalation survives the next cycle and a restart).
      orchestratorStores: (scope) => ({
        control: new PgControlStore(
          this.d.store.db,
          scope,
          chainOf({ dataSource: env.DATA_SOURCE, network: env.NEAR_NETWORK }),
          { now: this.d.now },
        ),
        idempotency: new PgIdempotencyStore(this.d.store.db, scope, { now: this.d.now }),
      }),
    });
    const run = await wired.cycle.run();
    const portfolio = DEMO_PORTFOLIOS[pid];
    const ids = demoAssets('mainnet');
    const pNear = prices.get(ids.near.token);
    const pUsdt = prices.get(ids.usdt.token);
    const walletUsd =
      pNear && pUsdt
        ? Number(toWad(mul(fromRaw(portfolio.wallet.near, 24), pNear.usd))) / 1e18 +
          Number(toWad(mul(fromRaw(portfolio.wallet.usdt, 6), pUsdt.usd))) / 1e18
        : null;
    const capital = walletUsd === null ? 0 : Math.round(walletUsd * 100) / 100;
    const lpSims: LpSimResult[] = pools
      .filter(
        (v) =>
          v.c.category === 'LP_SIMULATION_ELIGIBLE' &&
          v.pool.reserves.length === 2 &&
          v.pool.feeBps !== null,
      )
      .map((v) => {
        const w =
          v.windows.find(
            (x) => x.quality === 'OK' && x.annualizedApr && x.window !== 'SINCE_FIRST',
          ) ?? v.windows.find((x) => x.quality === 'OK');
        return simulateLpEntry({
          poolKey: v.pool.poolKey,
          tokens: [v.pool.tokens[0] ?? '', v.pool.tokens[1] ?? ''],
          reserves: [v.pool.reserves[0] ?? 0n, v.pool.reserves[1] ?? 0n],
          feeBps: v.pool.feeBps ?? 0,
          decimals: this.decimals,
          prices,
          capitalUsd: capital,
          horizonDays: this.d.horizonDays,
          gasUsdPerTx: this.d.gasUsdPerTx,
          windows: v.windows,
          rawRatioRange: w?.range ?? null,
        });
      });
    const held = new Set<string>([ids.near.token, ids.usdt.token]);
    const bestLp =
      [...lpSims]
        .filter(
          (s) =>
            s.status === 'OK' &&
            pools.find((v) => v.pool.poolKey === s.poolKey)?.pool.tokens.some((t) => held.has(t)),
        )
        .sort((a, b) => Number(b.netReturnUsd) - Number(a.netReturnUsd))[0] ?? null;
    // Best allowlisted stable to swap wNEAR into, priced on the allowlisted pool's reserves of this snapshot.
    const swapToBest = (() => {
      for (const route of this.d.config.rhea.pools) {
        const other =
          route.tokenA === ids.near.token
            ? route.tokenB
            : route.tokenB === ids.near.token
              ? route.tokenA
              : null;
        const v = pools.find((p) => p.pool.poolKey === `v1:${route.poolId}`);
        const po = other ? prices.get(other) : undefined;
        const dOther = other ? this.decimals.get(other) : null;
        if (
          !other ||
          !v ||
          !pNear ||
          !po ||
          dOther === null ||
          dOther === undefined ||
          v.pool.feeBps === null
        )
          continue;
        const nearFirst = v.pool.tokens[0] === ids.near.token;
        const r: [bigint, bigint] = nearFirst
          ? [v.pool.reserves[0] ?? 0n, v.pool.reserves[1] ?? 0n]
          : [v.pool.reserves[1] ?? 0n, v.pool.reserves[0] ?? 0n];
        return {
          token: other,
          pool: `v1:${route.poolId}`,
          costUsd: swapCostUsd(capital, r, v.pool.feeBps, [24, dOther], [pNear.usd, po.usd]),
        };
      }
      return null;
    })();
    const strategies = compareStrategies({
      portfolio,
      tokens: { near: ids.near.token, usdt: ids.usdt.token },
      prices,
      markets,
      capitalUsd: capital,
      horizonDays: this.d.horizonDays,
      gasUsdPerTx: this.d.gasUsdPerTx,
      swapToBest,
      bestLp,
    });
    const decision = (report as CycleReport | null)?.decision ?? null;
    await this.d.store.insertAnalysis({
      id: `${snapshotId}:${pid}`,
      snapshotId,
      portfolioId: pid,
      runId: run.run.id,
      createdAt: this.d.now(),
      outcome: run.run.outcome,
      result: toJsonSafe({
        portfolio: { id: pid, description: portfolio.description, walletUsd, capitalUsd: capital },
        decision: decision
          ? {
              outcome: decision.outcome,
              reasons: decision.reasons,
              risk: decision.risk,
              rejected: decision.rejected,
              ranked: decision.ranked.map((c) => ({
                agent: c.agent,
                action: c.action,
                economics: c.economics,
              })),
              agentNoActions: decision.agentNoActions,
              wouldHaveActed: decision.wouldHaveActed
                ? { agent: decision.wouldHaveActed.agent, action: decision.wouldHaveActed.action }
                : null,
            }
          : null,
        runStatus: run.run.status,
        executionMode: 'dry-run',
        lpSimulations: lpSims,
        strategies,
      }),
    });
  }
}

interface PoolView {
  readonly pool: DiscoveredPool;
  readonly c: PoolClassification;
  readonly tracked: boolean;
  readonly windows: (FeeWindow & { range: { min: number; max: number; samples: number } | null })[];
  readonly historySeconds: number;
}
