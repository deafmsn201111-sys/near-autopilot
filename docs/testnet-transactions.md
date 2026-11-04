# Manually confirmed testnet transactions

The autopilot itself never signs: `loadSigner()` returns `null` and `EXECUTION_MODE=live` refuses to start. The
`testnet-tx` command is a separate, deliberately small tool for proving the signing and confirmation path on
**NEAR testnet only**, one confirmed operation at a time.

## What it can do

| Operation              | Contract       | Method            | Deposit                                  | Gas     |
| ---------------------- | -------------- | ----------------- | ---------------------------------------- | ------- |
| `wrap.storage_deposit` | `wrap.testnet` | `storage_deposit` | `storage_balance_bounds.min` (read live) | 30 Tgas |
| `wrap.near_deposit`    | `wrap.testnet` | `near_deposit`    | `--amount`, 0.001 to 0.05 NEAR           | 30 Tgas |

Nothing else can be expressed: no swap, borrow, repay, LP, withdraw or rebalance. Adding an operation is a code
change in `apps/api/src/testnet-tx/operations.ts`.

## Limits (code constants in `apps/api/src/testnet-tx/model.ts`)

- at most **0.1 NEAR** per operation, worst case (deposit + (attached gas + 5 Tgas) x gas price x 1.2);
- at most **1 NEAR** in total (actual cost of settled transactions, maximum cost of anything unresolved);
- at least **0.5 NEAR** left available on the account;
- a preview is valid for **10 minutes**.

## Guarantees, and where they are tested (`apps/api/test/testnet-tx.test.ts`)

- The RPC must report chain id `testnet`; the account must be `TESTNET_ACCOUNT_ID` (a `*.testnet` account).
- `preview` is read-only and records the preview (`prepared`, or `rejected` with the reason).
- `send` signs only if the user repeats the **exact preview hash**, the preview is fresh, the transaction rebuilt from
  live state is identical to the confirmed one, all limits pass again, and the key is a full-access key of the
  account (attached deposits need one).
- The preview is claimed with a compare-and-set in Postgres: a second `send` of the same preview signs nothing.
- The transaction hash is stored **before** broadcasting. Broadcasting happens once; it is never retried.
- An errored broadcast is `unknown` (counted at its maximum cost) and blocks further sends until `status` reconciles
  it. Only a final, successful on-chain outcome becomes `confirmed`; a failed one is `failed`.

Statuses: `prepared -> approved -> submitted -> confirmed`, plus `rejected`, `failed`, `expired`, `unknown`.

## Key setup (done by you, locally; never paste a key into chat or the repository)

The signer reads a near-cli style key file **outside** this repository:

```json
{ "account_id": "sergetest.testnet", "public_key": "ed25519:...", "private_key": "ed25519:..." }
```

Export the account's key from the wallet that holds it, or add a new full-access key with your NEAR CLI (check its
own documentation for the exact command), and save it in that format, e.g. at
`~/.near-credentials/testnet/sergetest.testnet.json`. Then:

```bash
chmod 600 ~/.near-credentials/testnet/sergetest.testnet.json   # the tool refuses group/world-readable files
```

The tool checks that the file's account matches, that its public key matches its private key, and that the key is
registered on-chain with full access. The key is held only inside the signer (not on the object, so it cannot be
logged) and is never printed.

## Running

From `apps/api` (reads `../../.env` for `DATABASE_URL`, `TESTNET_ACCOUNT_ID`, `TESTNET_RPC_URL`):

```bash
pnpm testnet-tx preview wrap.storage_deposit          # read-only: shows network, account, contract, method,
                                                      # arguments, deposit, max fee, expected result, risks, hash
TESTNET_SIGNER_KEY_FILE=~/.near-credentials/testnet/sergetest.testnet.json \
  pnpm testnet-tx send <previewHash> --confirm <previewHash>
pnpm testnet-tx status <txHash>                       # read-only: final outcome, actual cost
pnpm testnet-tx ledger                                # all records and the budget used
```

Check an outcome independently at `https://testnet.nearblocks.io/txns/<txHash>`, or with the RPC `tx` method. The
testnet dashboard (`http://127.0.0.1:3002/activity`) lists the ledger read-only.
