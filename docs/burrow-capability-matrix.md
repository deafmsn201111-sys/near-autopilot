# Burrow Finance capability matrix

What `@near-autopilot/burrow-adapter` implements, what it deliberately does not, and what evidence backs each
claim. Written to be re-checked: every row names its source, and anything that could not be verified from the
build sandbox is marked as such rather than assumed.

## 1. Evidence tiers

| Tier  | Meaning                                 | Where it was read                                                                                                               |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **S** | Contract source                         | `burrowfdn/burrowland` @ `0dbfa18` (2022-07-08, `contract/Cargo.toml` v0.7.0); `NearDeFi/price-oracle` @ `df2efbe` (2025-10-31) |
| **A** | Official frontend (shipped client code) | `burrowfdn/burrow-cash` @ `bcb204b` (2023-12-28)                                                                                |
| **R** | Runtime proof on a live chain           | `BurrowVerifier` (code export check) and the opt-in live test. **Not obtained during development**, see section 8               |

Notes on "the official SDK and API":

- I found **no standalone Burrow SDK package** in the burrowfdn repositories examined. The de-facto client is
  the `burrow-cash` frontend (`store/actions/*.ts`), which is why tier A is that repository.
- `burrowfdn/burrow-api` @ `f20fc02` (2022-11-01) is a small Next.js service for transaction counts/lists,
  rewards and IP blocking (`pages/api/{transactions,rewards,is-blocked,ip}`). It does not expose markets,
  positions or prices, so nothing here depends on it. The adapter reads the contracts directly.
- The npm registry was unreachable from the build sandbox, so the existence of a published SDK on npm was not
  checked. If one exists, it is not a source this document relies on.
- The deployed contracts may be **newer** than the commits above (burrowland's commit is from 2022). That is
  why method names are re-proven against the deployed WASM at runtime (section 6) instead of trusted.

## 2. Contracts and networks

| Deployment     | Network | Account                              | Source of the id                                |
| -------------- | ------- | ------------------------------------ | ----------------------------------------------- |
| `mainnet`      | mainnet | `contract.main.burrow.near`          | A: `store/constants.ts:57`                      |
| `mainnet-beta` | mainnet | `contract.beta.burrow.near`          | A: `store/constants.ts:58`                      |
| `testnet`      | testnet | `contract.1638481328.burrow.testnet` | A: `README.md:37` (`NEXT_PUBLIC_CONTRACT_NAME`) |

- A contract id is accepted only if it is listed **for the configured network** (or the operator explicitly sets
  `allowUnlistedContract` for a fork). A mainnet account configured on testnet is rejected before any RPC call.
- The oracle account is **not hard-coded**. It is read from the contract's own `get_config.oracle_account_id`
  (S: `config.rs:83`) and compared with the operator-configured `BURROW_ORACLE_ID`. The default
  `priceoracle.near` in `packages/config` is **unverified**; on any mismatch verification fails.
- Whether each account above currently has code deployed on its chain is **not assumed**: verification proves it.

## 3. Method matrix

| Method                                          | Kind                                | Used for                                                              | Evidence                                                         | Implemented                         |
| ----------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `get_config`                                    | view                                | oracle account, recency limits                                        | S `config.rs:83`                                                 | yes                                 |
| `get_asset {token_id}`                          | view                                | listing, `volatility_ratio`, `extra_decimals`, flags                  | S `asset.rs:165`; A                                              | yes                                 |
| `get_assets_paged_detailed {from_index, limit}` | view                                | market listing                                                        | S `asset.rs:201`; A                                              | yes (de-duplicating pager, see 3.1) |
| `get_account {account_id}`                      | view                                | supplied / collateral / borrowed (inner units); `null` = unregistered | S `account.rs:199`; A                                            | yes                                 |
| `storage_balance_of {account_id}`               | view                                | NEP-145 registration                                                  | S `storage.rs:185`                                               | yes                                 |
| `get_price_data {asset_ids}` (oracle)           | view                                | prices, block timestamp, recency                                      | S price-oracle `lib.rs:117`                                      | yes                                 |
| `ft_on_transfer`                                | call via token's `ft_transfer_call` | repay / supply / supply-as-collateral                                 | S `fungible_token.rs:24`; A `repay.ts`, `supply.ts`              | yes (builders)                      |
| `execute {actions}`                             | payable call, 1 yocto               | promote supplied balance to collateral                                | S `actions.rs:541` (`assert_one_yocto`); A `adjustCollateral.ts` | yes (builder)                       |
| `oracle_on_call`                                | callback from oracle                | priced actions                                                        | S `price_receiver.rs:35`                                         | export checked only                 |
| borrow, withdraw (`oracle_call` → `execute`)    | via oracle                          | borrow to wallet, withdraw supplied/collateral                        | S; A `buildBorrow`, `buildWithdraw` (`builders.ts:161,184`)      | yes (builders, prepare intents)     |
| decrease collateral, liquidate                  |                                     |                                                                       | S                                                                | **not implemented, on purpose**     |

### 3.1 Notes

- **Paging.** I could not confirm whether the deployed `get_assets_paged_detailed` treats `limit` as a page size or
  an end index (the two have both appeared in the Burrow ecosystem). The client requests `limit = from + 50`,
  de-duplicates by token id, and stops on the first page that adds nothing. Both semantics are unit-tested.
- **Unregistered accounts.** `ft_on_transfer` panics for an account that is not registered (the transfer then
  bounces). The `/v1/wallet/prepare` path prepends `buildBurrowStorageDeposit` (deposit = on-chain
  `storage_balance_bounds().min`) when `storage_balance_of` reports the signer is not registered. The older
  planner still requires `get_account` to be non-null.
- **Risk-lowering actions.** Borrow and withdraw lower a health factor, so they go through a priced `oracle_call`
  flow and Burrow reverts if collateral no longer covers the debt. They exist only as user-signed prepare intents;
  the planner's `supports()` still covers repay and supply only.

## 4. Interface shapes (exact, as built)

All amounts that go to Burrow in `max_amount` are **inner units**; `amount` of `ft_transfer_call` is **raw token units**.

**Repay** (receiver = the token contract):

```
receiver_id: <token>
method:      ft_transfer_call
args:        { receiver_id: <burrow>, amount: "<raw>", msg: "{\"Execute\":{\"actions\":[{\"Repay\":{\"token_id\":\"<token>\",\"max_amount\":\"<raw * 10^extra_decimals>\"}}]}}" }
deposit:     1 yoctoNEAR        gas: 100 Tgas
```

`Repay` with `max_amount` repays at most that amount; surplus stays as a supplied (non-collateral) balance
(S `actions.rs`, share conversion around `:511`). A: `repay.ts` / `supply.ts` use the same shapes and 100 Tgas.

**Supply as collateral**: same call with `IncreaseCollateral` instead of `Repay`. **Plain supply**: empty `msg`.

**Increase collateral from already-supplied balance** (receiver = Burrow):

```
method:  execute
args:    { actions: [{ IncreaseCollateral: { token_id: "<token>", max_amount?: "<inner>" } }] }
deposit: 1 yoctoNEAR        gas: 50 Tgas
```

Omitting `max_amount` moves the entire supplied balance of that token.

## 5. Units, the `extra_decimals` pitfall

Burrow stores balances as `raw * 10^extra_decimals` (S `fungible_token.rs:37` multiplies on deposit; `:76` divides on
withdrawal). The contract's own example: USDT has 6 decimals, `extra_decimals = 12`, giving an 18-decimal inner balance
(S `asset_config.rs:52`). `get_account` returns **inner** units.

The first version of this adapter's reader ignored this and treated inner balances as raw. That bug was found
during this work and fixed: the reader now converts per asset, rounding holdings **down** and debt **up**, so a
position can only ever look slightly worse than it is. Oracle prices are USD per **raw** unit
(`multiplier / 10^decimals`); the contract values a balance as
`inner * multiplier / 10^(price.decimals + extra_decimals)` (S `big_decimal.rs:189`), which is the same thing.

## 6. Verification before any transaction is built

Transaction builders accept only proofs minted by `BurrowVerifier`. The types are branded, and proofs are also
registered in a runtime `WeakSet` and frozen, so a hand-built or copied object is refused (`UNVERIFIED_PROOF`).

`verifyDeployment()` performs, in this order, and stops at the first failure:

1. Contract id is a listed deployment for the configured network (no RPC traffic otherwise).
2. RPC `status.chain_id` equals the configured network (`NetworkMismatchError`). _This guards against pointing a
   testnet config at a mainnet endpoint and vice versa; it is not a defence against a hostile RPC node._
3. The WASM deployed at the Burrow contract (`view_code`, final finality) **exports** every method the adapter uses.
4. Optional code-hash allowlist for Burrow.
5. `get_config.oracle_account_id` equals the expected oracle (`ORACLE_MISMATCH`).
6. The oracle's deployed WASM exports `get_price_data` and `oracle_call`; optional code-hash allowlist.

`verifyToken()` additionally proves that the token is listed by this deployment, `can_deposit` is true (and
`can_use_as_collateral` for the collateral purpose), is not Burrow or its oracle, and exports `ft_transfer_call` and
`ft_balance_of`. Both proofs expire (default 5 minutes) and builders re-check expiry with an injected clock.

**What this proves and what it does not.** Export checking proves a method _name_ exists on the deployed code. It
does not prove argument shapes; those rest on tiers S and A. Genesis hashes are not pinned, so chain identity is a
reported `chain_id` string.

## 7. Risk mathematics

Reproduced from the contract (S `actions.rs:457` `compute_max_discount`), in bigint USD scaled by 10^18:

```
collateral_sum = Σ collateral_value * volatility_ratio / 10000        (rounded down)
borrowed_sum   = Σ borrowed_value   * 10000 / volatility_ratio        (rounded up)
liquidatable   ⇔ there is debt AND borrowed_sum > collateral_sum      (equality is SAFE)
max discount   = (borrowed_sum − collateral_sum) / borrowed_sum / 2
health factor  = collateral_sum / borrowed_sum                        (floor, in bps; 10000 = at the line)
LTV            = borrowed_value / collateral_value                    (ceil, in bps, unweighted)
liq. threshold = health factor × LTV                                  (LTV at which this position is liquidatable)
```

- Burrow has **one** ratio per asset (`volatility_ratio`): it weights collateral and divides debt. The generic
  `AssetRisk` therefore carries it as both collateral and borrow factor.
- Only **collateral** counts. Supplied-but-not-collateral balances are ignored.
- A missing price or missing asset parameters throws `MissingPriceError`; nothing is valued at zero or guessed.
- The oracle returns `null` for prices older than its `recency_duration_sec`, so a stale asset is simply
  unpriced and valuation fails closed. `asOf` is the **block time of the view**, not of the last price report.
- Stress scenarios apply bps shocks to collateral and/or debt prices (default set: collateral −10/−20/−30/−50%,
  debt +10/+25%, and a combination), with per-token overrides. `breakevenMoveBps` gives the largest single-asset
  move that is still safe; it is tested to be safe at that value and liquidatable one bp beyond.
- Differences from the contract: it truncates at 10^27; this uses 10^18 with pessimistic rounding. The difference
  is below 10^-15 USD, always in the direction of "looks worse".
- Interest accrual is not projected. Model it through `debtShockBps`.

## 8. Testnet support: what is and is not established

| Claim                                                   | Status                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Burrow publishes a testnet contract id                  | **Documented** (A: `burrow-cash/README.md:37`)                                 |
| That account currently has the expected code on testnet | **Not verified.** The build sandbox could not reach any NEAR RPC.              |
| Its interface matches burrowland v0.7.0                 | **Not verified.** Enforced at runtime by the export check                      |
| Testnet oracle account id                               | **Unknown.** Must be set via `BURROW_ORACLE_ID`; verified against `get_config` |
| Testnet markets / test tokens with liquidity            | **Unknown.** Never assumed by any code or test                                 |
| Repay / increase-collateral succeed on testnet          | **Never executed** by this project                                             |

Consequently the builders are gated: on testnet they produce a transaction only after `verifyDeployment()` and
`verifyToken()` succeed against the live chain. To check testnet support yourself (read-only, no keys):

```
BURROW_LIVE=1 pnpm --filter @near-autopilot/burrow-adapter test:live
# BURROW_DEPLOYMENT=testnet|mainnet|mainnet-beta, BURROW_RPC_URL=..., BURROW_CONTRACT_ID=..., BURROW_ACCOUNT_ID=...
```

A failure there on testnet is a finding (deployment retired or interface changed), not a flaky test.

## 9. Signing keys

- The repository ships **no signer** (`apps/api/src/signer.ts` returns `null`) and the adapter has no key handling.
- `loadApiEnv` rejects `EXECUTION_MODE=live` together with `NEAR_NETWORK=mainnet`, and `wire()` re-checks it. There is
  no override. Mainnet is therefore dry-run only: it plans and reads, and never signs.
- The live Burrow test reads no key material and sends no transaction.

## 10. Known gaps

1. Deployed contract versions unverified against the source commits (drift is possible); mitigated by export checks, not eliminated.
2. Argument shapes of `Execute` actions are tier S/A only; there is no runtime proof until a testnet transaction is made.
3. Genesis hashes are not pinned.
4. Oracle price format is read from price-oracle source (`df2efbe`); the deployed oracle for a given network was not inspected.
5. Pager semantics of `get_assets_paged_detailed` are tolerated, not established.
6. Farm/booster rewards and `net_tvl_multiplier` effects are not part of any calculation.
7. No decrease-collateral or liquidation support. Borrow and withdraw exist only as user-signed prepare intents.
