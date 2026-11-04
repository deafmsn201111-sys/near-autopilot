import type {
  AccountId,
  AssetBalance,
  AssetRisk,
  ContractViewer,
  LendingPosition,
  LendingReader,
  PriceMap,
  PriceOracle,
  TokenId,
  UnitPrice,
} from '@near-autopilot/core';
import { AutopilotError, UnexpectedResponseError } from '@near-autopilot/core';
import { BurrowClient, BurrowOracleClient, type BurrowAsset, type BurrowAccount } from './client';
import type { RiskAsset, RiskPosition } from './risk';
import { innerToRaw } from './units';

export interface BurrowOptions {
  /** Main Burrow contract. */
  readonly contractId: AccountId;
  /** The oracle this system expects Burrow to use. Prices are refused if Burrow is configured with another. */
  readonly oracleId: AccountId;
}

export class OracleMismatchError extends AutopilotError {
  constructor(configured: AccountId, expected: AccountId) {
    super(
      'ORACLE_MISMATCH',
      `Burrow is configured with oracle ${configured}, but ${expected} was expected; refusing to read prices`,
    );
  }
}

/** Reads Burrow positions and asset parameters, converting Burrow inner units to raw token units. */
export class BurrowLendingReader implements LendingReader {
  private readonly client: BurrowClient;

  constructor(viewer: ContractViewer, options: BurrowOptions) {
    this.client = new BurrowClient(viewer, options.contractId);
  }

  private async assetsFor(tokens: Iterable<TokenId>): Promise<Map<TokenId, BurrowAsset>> {
    const unique = [...new Set(tokens)];
    const found = await Promise.all(
      unique.map(async (t) => [t, await this.client.getAsset(t)] as const),
    );
    const map = new Map<TokenId, BurrowAsset>();
    for (const [token, asset] of found) {
      if (!asset)
        throw new UnexpectedResponseError(
          `${this.client.contractId}#get_asset`,
          `${token} is held by the account but not listed`,
        );
      map.set(token, asset);
    }
    return map;
  }

  private static tokensOf(account: BurrowAccount): TokenId[] {
    return [...account.supplied, ...account.collateral, ...account.borrowed].map((b) => b.tokenId);
  }

  /**
   * Raw token units. Holdings round DOWN and debt rounds UP, so a position can only look slightly worse than it
   * is. (For assets with `extra_decimals = 0` the conversion is exact.)
   */
  async getPosition(accountId: AccountId): Promise<LendingPosition> {
    const account = await this.client.getAccount(accountId);
    if (!account)
      return { protocol: 'burrow', accountId, supplied: [], collateral: [], borrowed: [] };
    const assets = await this.assetsFor(BurrowLendingReader.tokensOf(account));
    const convert = (
      entries: BurrowAccount['supplied'],
      rounding: 'floor' | 'ceil',
    ): AssetBalance[] =>
      entries
        .map((e) => ({
          token: e.tokenId,
          raw: innerToRaw(e.inner, assets.get(e.tokenId)!.extraDecimals, rounding),
        }))
        .filter((b) => b.raw > 0n);
    return {
      protocol: 'burrow',
      accountId,
      supplied: convert(account.supplied, 'floor'),
      collateral: convert(account.collateral, 'floor'),
      borrowed: convert(account.borrowed, 'ceil'),
    };
  }

  /** Inputs for `computeRisk`: the account in Burrow inner units plus each asset's volatility ratio and extra decimals. */
  async getRiskInputs(
    accountId: AccountId,
  ): Promise<{ position: RiskPosition; assets: ReadonlyMap<TokenId, RiskAsset> } | null> {
    const account = await this.client.getAccount(accountId);
    if (!account) return null;
    const assets = await this.assetsFor(
      [...account.collateral, ...account.borrowed].map((b) => b.tokenId),
    );
    const riskAssets = new Map<TokenId, RiskAsset>();
    for (const [tokenId, a] of assets) {
      riskAssets.set(tokenId, {
        tokenId,
        extraDecimals: a.extraDecimals,
        volatilityRatioBps: a.volatilityRatioBps,
      });
    }
    return {
      position: { collateral: account.collateral, borrowed: account.borrowed },
      assets: riskAssets,
    };
  }

  /**
   * Burrow has ONE ratio per asset: it weights collateral and divides debt (S: actions.rs). The generic
   * `AssetRisk` therefore carries it as both the collateral factor and the borrow factor.
   */
  async getRisk(tokens: readonly TokenId[]): Promise<ReadonlyMap<TokenId, AssetRisk>> {
    const entries = await Promise.all(
      [...new Set(tokens)].map(async (token): Promise<[TokenId, AssetRisk] | null> => {
        const asset = await this.client.getAsset(token);
        if (!asset) return null;
        return [
          token,
          {
            token,
            collateralFactorBps: asset.volatilityRatioBps,
            borrowFactorBps: asset.volatilityRatioBps,
            canBeCollateral: asset.canUseAsCollateral,
            canBorrow: asset.canBorrow,
          },
        ];
      }),
    );
    return new Map(entries.filter((e): e is [TokenId, AssetRisk] => e !== null));
  }
}

/**
 * Prices from the oracle Burrow itself is configured with. On every call it first confirms that
 * `get_config.oracle_account_id` is the expected oracle, so a repointed or misconfigured oracle is refused.
 *
 * `asOf` is the BLOCK time of the view call, not the time of the last price report: the oracle already
 * withholds (returns null for) any price older than its `recency_duration_sec`, and tokens without a recent
 * price are simply absent from the result, which makes valuation fail closed.
 */
export class BurrowPriceOracle implements PriceOracle {
  private readonly client: BurrowClient;
  private readonly oracle: BurrowOracleClient;

  constructor(
    viewer: ContractViewer,
    private readonly options: BurrowOptions,
  ) {
    this.client = new BurrowClient(viewer, options.contractId);
    this.oracle = new BurrowOracleClient(viewer, options.oracleId);
  }

  async getPrices(tokens: readonly TokenId[]): Promise<{ prices: PriceMap; asOf: Date }> {
    const config = await this.client.getConfig();
    if (config.oracleAccountId !== this.options.oracleId)
      throw new OracleMismatchError(config.oracleAccountId, this.options.oracleId);
    const data = await this.oracle.getPriceData(tokens);
    const prices = new Map<TokenId, UnitPrice>();
    for (const [assetId, price] of data.prices) prices.set(assetId as TokenId, price);
    return { prices, asOf: new Date(Number(data.blockTimestampNs / 1_000_000n)) };
  }
}
