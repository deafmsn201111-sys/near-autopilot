import { BurrowClient } from '@near-autopilot/burrow-adapter';
import { accountIdSchema, errorMessage, type AccountId } from '@near-autopilot/core';
import { NearTokenReader, type NearRpcClient } from '@near-autopilot/near-adapter';
import { RheaPoolReader } from '@near-autopilot/rhea-adapter';
import { RheaDclClient } from '@near-autopilot/rhea-dcl-adapter';
import type { Decimal } from '../market-data/decimal';
import { failureKind } from '../public-text';
import { burrowEstimates, type YieldLimits } from './burrow';
import type {
  BlockRef,
  PoolHistory,
  YieldDataProvider,
  YieldEstimate,
  YieldReport,
  YieldReportSink,
  YieldNetwork,
  YieldSourceName,
  YieldSourceStatus,
} from './model';
import { finalBlock, PinnedViewer } from './pinned-viewer';
import { dclEstimate, rheaV1Estimate } from './rhea';

export interface YieldServiceOptions {
  readonly rpc: Pick<NearRpcClient, 'call'>;
  /** Network the contracts live on (checked at start-up by the caller). */
  readonly network?: YieldNetwork;
  readonly burrowContract: AccountId;
  readonly rheaContract: AccountId;
  readonly dclContract: AccountId | null;
  /** Rhea v1 pools to OBSERVE (config `yield.rheaV1Pools`). Observing is not allowlisting. */
  readonly rheaV1Pools: readonly number[];
  readonly dclPools: readonly string[];
  /** Operator-reviewed v1 pools (config `rhea.pools`). */
  readonly allowlist: ReadonlySet<number>;
  readonly allowedTokens: ReadonlySet<string>;
  /** USD per whole token from usable reference prices, for one report. */
  readonly prices: () => Promise<(token: string) => Decimal | null>;
  readonly history: PoolHistory | null;
  readonly limits: YieldLimits;
  readonly maxPriceDeviationBps: number;
  readonly minPeriodSeconds: number;
  readonly maxPeriodSeconds: number;
  readonly sink?: YieldReportSink;
  readonly now: () => Date;
  readonly ids: () => string;
  readonly ttlMs?: number;
  readonly onError?: (message: string) => void;
}

interface SourceRun {
  readonly status: YieldSourceStatus;
  readonly estimates: readonly YieldEstimate[];
}

/**
 * Mainnet yield data: Burrow lending rates, Rhea v1 pool fees, Rhea DCL pool state, all read at ONE final block.
 * Each source is isolated: a failing source is reported `unavailable` and contributes nothing; it is never replaced by
 * another protocol's data or by an older report. Reports are reused for `ttlMs` so a cycle sees one consistent set.
 */
export class YieldService implements YieldDataProvider {
  private cached: { at: number; value: Promise<YieldReport> } | null = null;

  constructor(private readonly o: YieldServiceOptions) {}

  private last: YieldReport | null = null;

  /** For a cycle (on demand): reuses a report younger than the TTL, else reads a new one at the latest final block. */
  report(): Promise<YieldReport> {
    const nowMs = this.o.now().getTime();
    if (this.cached && nowMs - this.cached.at < (this.o.ttlMs ?? 30_000)) return this.cached.value;
    return this.remember(nowMs, this.fetch(null, 'on_demand'));
  }

  /** For the collector: one report at exactly this block, marked `scheduled`; later cycles within the TTL reuse it. */
  reportAt(block: BlockRef, origin: YieldReport['origin'] = 'scheduled'): Promise<YieldReport> {
    return this.remember(this.o.now().getTime(), this.fetch(block, origin));
  }

  /** The last report built, without reading anything (dashboard and API reads must never create observations). */
  latest(): YieldReport | null {
    return this.last;
  }

  private remember(nowMs: number, value: Promise<YieldReport>): Promise<YieldReport> {
    this.cached = { at: nowMs, value };
    value.then(
      (r) => {
        this.last = r;
      },
      () => {
        if (this.cached?.value === value) this.cached = null;
      },
    );
    return value;
  }

  private status(
    source: YieldSourceName,
    contract: string,
    health: YieldSourceStatus['health'],
    detail: string | null,
    marketsRead: number,
  ): YieldSourceStatus {
    return { source, contract, health, detail, marketsRead };
  }

  private failed(what: string, error: unknown): string {
    this.o.onError?.(`yield ${what} failed: ${errorMessage(error)}`);
    return `failed: ${failureKind(error)}`;
  }

  private async fetch(
    pinned: BlockRef | null,
    origin: YieldReport['origin'],
  ): Promise<YieldReport> {
    const observedAt = this.o.now();
    let block: BlockRef | null = pinned;
    let runs: SourceRun[] = [];
    try {
      block ??= await finalBlock(this.o.rpc);
    } catch (error) {
      const detail = this.failed('final block', error);
      runs = [
        {
          status: this.status('burrow', this.o.burrowContract, 'unavailable', detail, 0),
          estimates: [],
        },
        {
          status: this.status('rhea_v1', this.o.rheaContract, 'unavailable', detail, 0),
          estimates: [],
        },
        {
          status: this.status(
            'rhea_dcl',
            this.o.dclContract ?? '',
            this.o.dclContract ? 'unavailable' : 'disabled',
            detail,
            0,
          ),
          estimates: [],
        },
      ];
    }
    if (block) {
      const viewer = new PinnedViewer(this.o.rpc, block);
      const tokens = new NearTokenReader(viewer);
      const decimalsCache = new Map<string, Promise<number | null>>();
      const decimalsOf = (t: string): Promise<number | null> => {
        let p = decimalsCache.get(t);
        if (!p) {
          p = tokens
            .getMetadata(accountIdSchema.parse(t))
            .then((m) => m.decimals)
            .catch(() => null);
          decimalsCache.set(t, p);
        }
        return p;
      };
      const decimalsFor = async (ts: readonly string[]) =>
        new Map(await Promise.all(ts.map(async (t) => [t, await decimalsOf(t)] as const)));
      const priceUsd = await this.o.prices().catch(() => () => null);
      const ctx = {
        network: this.o.network ?? 'mainnet',
        block,
        now: this.o.now(),
        priceUsd,
        allowedTokens: this.o.allowedTokens,
        limits: this.o.limits,
        maxPriceDeviationBps: this.o.maxPriceDeviationBps,
      };
      const pinned = block;
      runs = await Promise.all([
        this.burrow(viewer, decimalsFor, ctx),
        this.rheaV1(viewer, decimalsFor, ctx, pinned),
        this.dcl(viewer, decimalsFor, ctx),
      ]);
    }
    const report: YieldReport = {
      id: this.o.ids(),
      origin,
      network: this.o.network ?? 'mainnet',
      observedAt,
      block,
      sources: runs.map((r) => r.status),
      estimates: runs.flatMap((r) => r.estimates),
    };
    if (this.o.sink) {
      try {
        await this.o.sink.record(report);
      } catch {
        this.o.onError?.('could not persist the yield report');
      }
    }
    return report;
  }

  private async burrow(
    viewer: PinnedViewer,
    decimalsFor: (ts: readonly string[]) => Promise<Map<string, number | null>>,
    ctx: Omit<Parameters<typeof burrowEstimates>[0], 'contract' | 'assets' | 'decimals'>,
  ): Promise<SourceRun> {
    const contract = this.o.burrowContract;
    try {
      const assets = await new BurrowClient(viewer, contract).listAssets();
      const decimals = await decimalsFor([
        ...assets.map((a) => a.tokenId),
        ...assets.flatMap((a) => a.supplyFarms.map((f) => f.rewardToken)),
      ]);
      const estimates = burrowEstimates({ ...ctx, contract, assets, decimals });
      return { status: this.status('burrow', contract, 'ok', null, assets.length), estimates };
    } catch (error) {
      return {
        status: this.status('burrow', contract, 'unavailable', this.failed('burrow', error), 0),
        estimates: [],
      };
    }
  }

  private async rheaV1(
    viewer: PinnedViewer,
    decimalsFor: (ts: readonly string[]) => Promise<Map<string, number | null>>,
    ctx: Omit<
      Parameters<typeof rheaV1Estimate>[0],
      | 'contract'
      | 'pool'
      | 'volumes'
      | 'adminFeeBps'
      | 'allowlist'
      | 'previous'
      | 'minPeriodSeconds'
      | 'maxPeriodSeconds'
      | 'decimals'
    >,
    block: BlockRef,
  ): Promise<SourceRun> {
    const contract = this.o.rheaContract;
    if (this.o.rheaV1Pools.length === 0)
      return {
        status: this.status(
          'rhea_v1',
          contract,
          'disabled',
          'no pools configured to observe (yield.rheaV1Pools)',
          0,
        ),
        estimates: [],
      };
    try {
      const reader = new RheaPoolReader(viewer, contract);
      const meta = await reader.metadata();
      if (meta.state !== 'Running')
        return {
          status: this.status(
            'rhea_v1',
            contract,
            'unavailable',
            `exchange state is ${meta.state}`,
            0,
          ),
          estimates: [],
        };
      const estimates = await Promise.all(
        this.o.rheaV1Pools.map(async (poolId) => {
          const [pool, volumes] = await Promise.all([
            reader.getPool(poolId),
            reader.getVolumes(poolId),
          ]);
          const decimals = await decimalsFor(pool.tokens);
          const previous = this.o.history
            ? await this.o.history
                .previous('rhea_v1', `pool:${poolId}`, block.timestamp, this.o.minPeriodSeconds)
                .catch(() => null)
            : null;
          return rheaV1Estimate({
            ...ctx,
            contract,
            decimals,
            pool,
            volumes,
            adminFeeBps: meta.adminFeeBps,
            allowlist: this.o.allowlist,
            previous,
            minPeriodSeconds: this.o.minPeriodSeconds,
            maxPeriodSeconds: this.o.maxPeriodSeconds,
          });
        }),
      );
      return {
        status: this.status(
          'rhea_v1',
          contract,
          'ok',
          `exchange v${meta.version}`,
          estimates.length,
        ),
        estimates,
      };
    } catch (error) {
      return {
        status: this.status('rhea_v1', contract, 'unavailable', this.failed('rhea_v1', error), 0),
        estimates: [],
      };
    }
  }

  private async dcl(
    viewer: PinnedViewer,
    decimalsFor: (ts: readonly string[]) => Promise<Map<string, number | null>>,
    ctx: Omit<Parameters<typeof dclEstimate>[0], 'contract' | 'pool' | 'decimals'>,
  ): Promise<SourceRun> {
    const contract = this.o.dclContract;
    if (!contract)
      return {
        status: this.status('rhea_dcl', '', 'disabled', 'no DCL contract configured', 0),
        estimates: [],
      };
    if (this.o.dclPools.length === 0)
      return {
        status: this.status(
          'rhea_dcl',
          contract,
          'disabled',
          'no pools configured to observe (yield.dclPools)',
          0,
        ),
        estimates: [],
      };
    try {
      const client = new RheaDclClient(viewer, { contractId: contract });
      const estimates: YieldEstimate[] = [];
      const missing: string[] = [];
      // Configured pools only, one get_pool each: no listing of 11k+ pools, no view-gas risk.
      for (const id of this.o.dclPools) {
        const pool = await client.getPool(id);
        if (!pool) {
          missing.push(id);
          continue;
        }
        const decimals = await decimalsFor([pool.token_x, pool.token_y]);
        estimates.push(dclEstimate({ ...ctx, contract, pool, decimals }));
      }
      return {
        status: this.status(
          'rhea_dcl',
          contract,
          'ok',
          missing.length > 0 ? `unknown pools: ${missing.join(', ')}` : null,
          estimates.length,
        ),
        estimates,
      };
    } catch (error) {
      return {
        status: this.status('rhea_dcl', contract, 'unavailable', this.failed('rhea_dcl', error), 0),
        estimates: [],
      };
    }
  }
}
