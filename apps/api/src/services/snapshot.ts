import type {
  AccountId,
  AssetBalance,
  Clock,
  LendingReader,
  NativeBalanceReader,
  PortfolioSnapshot,
  PriceOracle,
  TokenId,
  TokenInfo,
  TokenReader,
} from '@near-autopilot/core';

export interface SnapshotDeps {
  readonly accountId: AccountId;
  /** Tokens always tracked in the wallet (in addition to anything in the lending position). */
  readonly trackedTokens: readonly TokenId[];
  readonly native: NativeBalanceReader;
  readonly tokens: TokenReader;
  readonly lending: LendingReader;
  readonly oracle: PriceOracle;
  readonly clock: Clock;
}

/** Reads the chain and assembles one consistent view of the account. */
export class SnapshotService {
  constructor(private readonly deps: SnapshotDeps) {}

  async take(): Promise<PortfolioSnapshot> {
    const { accountId, native, tokens, lending, oracle, clock } = this.deps;

    const [nativeBalance, position] = await Promise.all([
      native.getNativeBalance(accountId),
      lending.getPosition(accountId),
    ]);

    const universe = [
      ...new Set<TokenId>([
        ...this.deps.trackedTokens,
        ...position.supplied.map((b) => b.token),
        ...position.collateral.map((b) => b.token),
        ...position.borrowed.map((b) => b.token),
      ]),
    ];

    const [balances, metadata, priceResult, risk] = await Promise.all([
      Promise.all(
        universe.map(async (token): Promise<AssetBalance> => ({
          token,
          raw: await tokens.getBalance(token, accountId),
        })),
      ),
      Promise.all(universe.map((token) => tokens.getMetadata(token))),
      oracle.getPrices(universe),
      lending.getRisk(universe),
    ]);

    return {
      accountId,
      takenAt: clock.now(),
      pricesAsOf: priceResult.asOf,
      nativeBalance,
      walletBalances: balances.filter((b) => b.raw > 0n),
      lending: position,
      prices: priceResult.prices,
      risk,
      tokens: new Map<TokenId, TokenInfo>(metadata.map((m) => [m.id, m])),
    };
  }
}

/** Short-lived cache so dashboard polling does not hammer the RPC. */
export class CachedSnapshotService {
  private cached: { at: number; value: Promise<PortfolioSnapshot> } | null = null;

  constructor(
    private readonly inner: Pick<SnapshotService, 'take'>,
    private readonly ttlMs = 15_000,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** Drop the cached snapshot (the simulated state changed): the next read is fresh. */
  invalidate(): void {
    this.cached = null;
  }

  take(): Promise<PortfolioSnapshot> {
    const now = this.nowMs();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.value;
    const value = this.inner.take();
    this.cached = { at: now, value };
    value.catch(() => {
      if (this.cached?.value === value) this.cached = null;
    });
    return value;
  }
}
