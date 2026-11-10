import type { BurrowAsset } from '@near-autopilot/burrow-adapter';
import { compareDecimal, parseDecimal, type Decimal } from '../market-data/decimal';
import { dec, div, fromRaw, isNegative, mul, ratio, toBps } from './math';
import type { BlockRef, YieldEstimate, YieldNetwork, YieldReason } from './model';

export interface YieldLimits {
  /** A reported APR above this is treated as invalid (markets pinned at 100 % utilisation report ~250 %). */
  readonly maxAprBps: number;
  /** At or above this utilisation a supplier may be unable to withdraw: no strategic use. */
  readonly maxUtilizationBps: number;
  /** Withdrawable (lending) or pooled (LP) value below this, in USD, is too thin to rely on. */
  readonly minLiquidityUsd: number;
  /** The pinned block must be at most this old when the report is built. */
  readonly maxAgeSeconds: number;
}

export interface BurrowYieldInput {
  readonly network?: YieldNetwork;
  readonly contract: string;
  readonly assets: readonly BurrowAsset[];
  readonly block: BlockRef;
  readonly now: Date;
  /** Decimals of a token (ft_metadata), null if unreadable. */
  readonly decimals: ReadonlyMap<string, number | null>;
  /** USD per whole token from a usable (fresh, undisputed) reference price, or null. */
  readonly priceUsd: (token: string) => Decimal | null;
  /** Tokens the operator allows (policy.allowedTokens). Others are observed, never strategic. */
  readonly allowedTokens: ReadonlySet<string>;
  readonly limits: YieldLimits;
}

const METHODS = ['get_assets_paged_detailed'] as const;
const SUPPLY_FORMULA =
  'supply_apr as reported by burrowland AssetDetailedView (simple annual rate at current utilisation; ' +
  'farm rewards are separate lending_reward estimates)';
const pct = (d: Decimal): string => `${(Number(toBps(d)) / 100).toFixed(2)} %`;

/**
 * Burrow lending rates -> yield estimates. Pure. One `lending_supply` estimate per listed asset (the only kind that can
 * become strategic) and one `lending_borrow` (informational: a cost, never a yield on capital). Amounts in Burrow are
 * inner units (raw * 10^extra_decimals); ratios are unit-free, liquidity is converted back to raw first.
 */
export function burrowEstimates(input: BurrowYieldInput): YieldEstimate[] {
  const { block, now, limits } = input;
  const ageSeconds = (now.getTime() - block.timestamp.getTime()) / 1000;
  return input.assets.flatMap((a): YieldEstimate[] => {
    const supplied = a.suppliedInner;
    const reserved = a.reservedInner;
    const borrowed = a.borrowedInner;
    const pooled = supplied + reserved;
    const utilization = pooled > 0n ? ratio(borrowed, pooled) : null;
    const availableInner = pooled - borrowed;
    const decimals = input.decimals.get(a.tokenId) ?? null;
    const price = input.priceUsd(a.tokenId);
    const liquidityUsd =
      decimals !== null && price && availableInner >= 0n
        ? mul(fromRaw(availableInner / 10n ** BigInt(a.extraDecimals), decimals), price)
        : null;
    const raw = {
      supplied: supplied.toString(),
      reserved: reserved.toString(),
      borrowed: borrowed.toString(),
      extraDecimals: a.extraDecimals,
      supplyApr: a.supplyApr,
      borrowApr: a.borrowApr,
      canDeposit: a.canDeposit,
      canWithdraw: a.canWithdraw,
      tokenDecimals: decimals,
    };
    const base = {
      source: 'burrow',
      network: input.network ?? 'mainnet',
      contract: input.contract,
      methods: METHODS,
      marketId: a.tokenId,
      assetIds: [a.tokenId],
      apy: null,
      calculationMethod: 'source_reported',
      observationPeriodSeconds: null,
      utilization,
      liquidityUsd,
      volumeUsd: null,
      block,
      sourceTimestamp:
        a.lastUpdateTimestampNs === null
          ? null
          : new Date(Number(a.lastUpdateTimestampNs / 1_000_000n)),
      raw,
    } as const;

    const reasons: YieldReason[] = [];
    const supplyApr = a.supplyApr === null ? null : parseDecimal(a.supplyApr);
    if (a.supplyApr === null)
      reasons.push({ code: 'MISSING_YIELD_DATA', detail: 'supply_apr not reported' });
    else if (!supplyApr || isNegative(supplyApr))
      reasons.push({
        code: 'INVALID_YIELD_DATA',
        detail: `supply_apr "${a.supplyApr}" is not a rate`,
      });
    else if (compareDecimal(supplyApr, dec(BigInt(limits.maxAprBps), -4)) > 0)
      reasons.push({
        code: 'INVALID_YIELD_DATA',
        detail: `supply_apr ${pct(supplyApr)} is above the ${limits.maxAprBps / 100} % plausibility limit`,
      });
    if (!input.allowedTokens.has(a.tokenId))
      reasons.push({ code: 'UNVERIFIED_ASSET', detail: 'token is not in policy.allowedTokens' });
    if (!a.canDeposit || !a.canWithdraw)
      reasons.push({
        code: 'INVALID_YIELD_DATA',
        detail: `market does not allow ${!a.canDeposit ? 'deposits' : 'withdrawals'}`,
      });
    if (decimals === null)
      reasons.push({
        code: 'INVALID_YIELD_DATA',
        detail: 'token decimals unreadable (ft_metadata)',
      });
    if (utilization === null)
      reasons.push({ code: 'INSUFFICIENT_LIQUIDITY', detail: 'nothing supplied' });
    else if (availableInner < 0n || compareDecimal(utilization, dec(1n)) > 0)
      reasons.push({
        code: 'INVALID_YIELD_DATA',
        detail: `borrowed exceeds supplied + reserved (utilisation ${pct(utilization)})`,
      });
    else if (toBps(utilization) >= BigInt(limits.maxUtilizationBps))
      reasons.push({
        code: 'INSUFFICIENT_LIQUIDITY',
        detail: `utilisation ${pct(utilization)} is at or above ${limits.maxUtilizationBps / 100} %: withdrawals may be impossible`,
      });
    if (!price)
      reasons.push({
        code: 'MISSING_PRICE',
        detail: 'no usable price: withdrawable liquidity cannot be valued',
      });
    else if (liquidityUsd && compareDecimal(liquidityUsd, dec(BigInt(limits.minLiquidityUsd))) < 0)
      reasons.push({
        code: 'INSUFFICIENT_LIQUIDITY',
        detail: `withdrawable liquidity is below ${limits.minLiquidityUsd} USD`,
      });
    if (ageSeconds > limits.maxAgeSeconds)
      reasons.push({
        code: 'STALE_YIELD_DATA',
        detail: `block is ${Math.round(ageSeconds)} s old (limit ${limits.maxAgeSeconds} s)`,
      });

    const borrowApr = a.borrowApr === null ? null : parseDecimal(a.borrowApr);
    return [
      {
        ...base,
        yieldType: 'lending_supply',
        apr: supplyApr,
        formula: SUPPLY_FORMULA,
        priceStatus: price ? 'fresh' : 'missing',
        validationStatus: reasons.length === 0 ? 'valid' : 'rejected',
        reasons,
      },
      {
        ...base,
        yieldType: 'lending_borrow',
        apr: borrowApr && !isNegative(borrowApr) ? borrowApr : null,
        formula: 'borrow_apr as reported by burrowland (a cost to borrowers, not a yield)',
        priceStatus: 'not_needed',
        validationStatus: 'informational',
        reasons:
          borrowApr && !isNegative(borrowApr)
            ? []
            : [{ code: 'MISSING_YIELD_DATA', detail: 'borrow_apr not reported or invalid' }],
      },
      ...a.supplyFarms.map((f): YieldEstimate => {
        const r: YieldReason[] = reasons.map((x) => ({
          code: x.code,
          detail: `supply market: ${x.detail}`,
        }));
        const rewardDecimals = input.decimals.get(f.rewardToken) ?? null;
        const rewardPrice = input.priceUsd(f.rewardToken);
        let apr: Decimal | null = null;
        if (f.remainingRewards <= 0n)
          r.push({
            code: 'MISSING_YIELD_DATA',
            detail: 'reward programme has no remaining rewards',
          });
        if (f.boostedShares <= 0n || a.suppliedShares <= 0n || supplied <= 0n)
          r.push({
            code: 'MISSING_YIELD_DATA',
            detail: 'no boosted shares: the rate is undefined',
          });
        if (rewardDecimals === null)
          r.push({ code: 'INVALID_YIELD_DATA', detail: `${f.rewardToken}: decimals unreadable` });
        if (!rewardPrice)
          r.push({
            code: 'MISSING_PRICE',
            detail: `reward token ${f.rewardToken}: no usable price`,
          });
        if (
          rewardPrice &&
          price &&
          rewardDecimals !== null &&
          decimals !== null &&
          f.boostedShares > 0n &&
          a.suppliedShares > 0n &&
          supplied > 0n
        ) {
          // Base (un-boosted) rate: a supplier's s shares earn rpd * s / boosted per day, worth
          // s * balance / shares / 10^(dec+extra) tokens. APR = rpd*365*p_r*shares*10^(dec+extra) / (10^dr*boosted*balance*p_t).
          apr = div(
            mul(
              mul(dec(f.rewardPerDay * 365n * a.suppliedShares), rewardPrice),
              dec(1n, decimals + a.extraDecimals),
            ),
            mul(mul(dec(f.boostedShares * supplied), price), dec(1n, rewardDecimals)),
          );
          if (compareDecimal(apr, dec(BigInt(limits.maxAprBps), -4)) > 0)
            r.push({
              code: 'INVALID_YIELD_DATA',
              detail: `reward APR ${pct(apr)} is above the ${limits.maxAprBps / 100} % plausibility limit`,
            });
        }
        return {
          ...base,
          yieldType: 'lending_reward',
          marketId: `${a.tokenId}#reward:${f.rewardToken}`,
          assetIds: [a.tokenId, f.rewardToken],
          apr,
          calculationMethod: 'calculated',
          formula:
            'base reward APR = reward_per_day × 365 × price_reward / (boosted_shares × value per supply share); no booster',
          priceStatus: rewardPrice && price ? 'fresh' : 'missing',
          validationStatus: r.length === 0 ? 'valid' : 'rejected',
          reasons: r,
          raw: {
            ...raw,
            rewardToken: f.rewardToken,
            rewardPerDay: f.rewardPerDay.toString(),
            remainingRewards: f.remainingRewards.toString(),
            boostedShares: f.boostedShares.toString(),
            suppliedShares: a.suppliedShares.toString(),
            remainingDays:
              f.rewardPerDay > 0n ? (f.remainingRewards / f.rewardPerDay).toString() : null,
          },
        };
      }),
    ];
  });
}
