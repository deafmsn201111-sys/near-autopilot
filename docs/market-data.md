# Market data: MAINNET MARKET DATA → TESTNET EXECUTION

The testnet profile (`docker compose --profile testnet`, API `:4001`, dashboard `:3002`) reads the account, balances,
contracts and positions from **NEAR testnet**, and prices from **mainnet market data sources**. Mainnet is used for
nothing else: no mainnet RPC, signer, account or transaction exists anywhere in this path.

`MARKET_DATA=mainnet-reference` is accepted only with `NEAR_NETWORK=testnet`, `DATA_SOURCE=chain` and
`EXECUTION_MODE=dry-run` (`packages/config`, re-checked in `apps/api/src/wiring.ts`).

## What a price means here

The testnet tokens are test tokens with no market. A mainnet price applied to one is labelled
**`REFERENCE_PRICE — NOT A REAL TESTNET TOKEN PRICE`**: it lets the agents and the policy engine run their real
logic, but it does not confirm the token's value, liquidity, redeemability or that any trade is executable.

## Asset mapping (`apps/api/src/market-data/assets.ts`)

| Testnet token (decimals)        | Mainnet reference (decimals)                     | Pyth feed (USD)                   | DefiLlama keys (priority order)                           |
| ------------------------------- | ------------------------------------------------ | --------------------------------- | --------------------------------------------------------- |
| `wrap.testnet` wNEAR (24)       | NEAR / `wrap.near` (24)                          | `Crypto.NEAR/USD` `c415de8d…6750` | `coingecko:near`, `near:wrap.near`                        |
| `usdt.fakes.testnet` USDT.e (6) | USDT.e / `dac17f95…1ec7.factory.bridge.near` (6) | `Crypto.USDT/USD` `2b89b9dc…e53b` | `coingecko:tether`, `near:dac17f95…factory.bridge.near`   |
| `usdc.fakes.testnet` USDC.e (6) | USDC.e / `a0b86991…eb48.factory.bridge.near` (6) | `Crypto.USDC/USD` `eaa020c6…c94a` | `coingecko:usd-coin`, `near:a0b86991…factory.bridge.near` |

Verified on 2026-11-04: testnet `ft_metadata` (symbol, decimals), Pyth `/v2/price_feeds` (id ↔ symbol, USD quote),
DefiLlama `/prices/current` (symbol, decimals of the mainnet contract). At run time the mapping is checked again:
testnet decimals must match, Pyth feed ids must resolve to the expected symbol, DefiLlama contract keys must report
the expected symbol and decimals. Any mismatch leaves the asset `unpriced`. Every other token is `unpriced`.

## Sources and rules

1. **Pyth Hermes** (priority 1). Since August 2026 Hermes requires an API key (`Authorization: Bearer`). Set
   `PYTH_API_KEY` in the local `.env` only; without it Pyth is reported `unavailable` and is not called. Prices are
   exact integers with an exponent. Rejected: older than 60 s, more than 5 s in the future, non-positive, or a
   confidence interval wider than 2 % of the price.
2. **DefiLlama coins API** (priority 2, no key). Rejected: older than 180 s, future, non-positive, symbol or decimals
   not as mapped, DefiLlama confidence below 0.9.

Per asset (`resolveAsset` in `apps/api/src/market-data/service.ts`):

- valid prices further apart than the asset's limit (NEAR 200 bps, stablecoins 100 bps) → **`price_disputed`**: no
  price, excluded from every decision until reviewed;
- two different providers valid and agreeing → **`corroborated`**; the Pyth price is used;
- one provider valid → **`single_source`**: used, and flagged on the dashboard and in Postgres;
- nothing valid → **`unpriced`**, with every source's reason. A failure never becomes a price of 0.

There is no further fallback. HTTP: 8 s timeout, at most 2 retries with exponential backoff and jitter, `Retry-After`
honoured on 429/503, at most 2 requests in flight; 401/403/404 are never retried. One report is reused for 30 s so a
cycle sees one consistent price set. Amounts are exact decimals/BigInt end to end (`decimal.ts`).

## Where the data goes

- **Snapshot prices** (`ReferencePriceOracle`): usable assets only; `pricesAsOf` is the oldest publish time used, so
  the orchestrator's freshness rule (`maxPriceAgeSeconds`, 180 s in `config/autopilot.testnet.example.json`) applies.
- **Orchestrator market context** (`ReferenceMarketProvider`): `referencePrices` are the lower-priority cross-check
  observations (Market Intelligence compares two sources, never a price with itself); `volatility24hBps` is the 24 h
  high-low range of hourly DefiLlama prices (a volatility proxy). There is no yield source and no LP position, so the
  Capital Allocator and LP Optimizer report `insufficient_data`.
- **Postgres** `market_prices` (migration 0004): one row per asset per report with status, price, source, asset id,
  publish time, age, spread, reason, and every observation (jsonb). CHECK constraints pin `market_network = 'mainnet'`
  and `execution_network = 'testnet'`.
- **API** `GET /v1/market-data` and the dashboard page **Market data** (`http://127.0.0.1:3002/market`).
