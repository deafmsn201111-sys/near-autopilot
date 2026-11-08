# Public demo server

Runs the read-only mainnet analytics dashboard on a server, in public demo mode, over HTTPS.

**What it does:**

- reads NEAR mainnet with view calls only;
- analyses the two simulated demo portfolios ($500 and $5,000);
- lets a visitor run "Let the agent do it" on them as a dry run.

**What it cannot do:** it cannot sign or send anything.

- There is no signer, and the executor is dry-run.
- The network, the data source, the execution mode and `PUBLIC_DEMO=1` are fixed in `docker-compose.yml`, not read
  from `.env`.
- Operator controls (start an analysis, pause the collector, read-only mode) are refused on the server.
- Visitor actions are rate-limited ([`apps/analytics/lib/public-demo.ts`](../../apps/analytics/lib/public-demo.ts)).

Only Caddy is reachable from the internet, on ports 80 and 443. Postgres, the APIs and the collector are on the
internal Docker network.

## Server

- Linux with Docker Engine and the Compose plugin.
- 2 vCPU, 4 GB RAM, about 10 GB of disk.
- Inbound ports 22, 80 and 443 open.

## 1. Build the bundle (developer machine)

```bash
deploy/public/build-bundle.sh linux/amd64     # or linux/arm64 for an ARM server
```

The script:

- builds the images for that platform;
- checks that no `.env`, key or checkpoint file is inside them;
- writes `deploy/public/dist/near-autopilot-public-<commit>.tar.gz`.

The bundle holds the images, this folder and the shadow policy config. It contains no secrets.

## 2. Install on the server

```bash
scp deploy/public/dist/near-autopilot-public-<commit>.tar.gz user@SERVER:
ssh user@SERVER
tar xzf near-autopilot-public-<commit>.tar.gz && cd near-autopilot-public-<commit>
./setup.sh <server public IP>     # loads the images, creates .env with new random secrets
nano .env                         # MAINNET_READ_RPC_API_KEY=<your FastNEAR key>
./setup.sh                        # starts the stack
```

The first `./setup.sh <IP>` call:

- creates `.env` with a random database password, an API token and a **new** audit checkpoint key pair;
- sets `SITE_ADDRESS=<IP>.sslip.io`, a public DNS name that resolves to that IP, so Caddy can get a real HTTPS
  certificate without a domain of your own.

Nothing secret is printed. To use your own domain instead, point it at the server and set `SITE_ADDRESS` to it.

Without a FastNEAR key, set `MAINNET_READ_RPC_URL=https://rpc.mainnet.near.org`. It is slower and rate-limited.

## 3. Check it

| Check            | Command or page                                                                  | Expected                                     |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| Containers       | `docker compose ps`                                                              | all `healthy`                                |
| Site             | `https://<IP>.sslip.io`                                                          | the dashboard, with the "Public demo" banner |
| Collector cycles | `docker compose logs -f shadow-collector`                                        | a cycle every 15 minutes                     |
| Audit trail      | `docker compose exec analytics-api node --import tsx src/evidence/cli.ts verify` | chains and checkpoints `ok`                  |
| Nothing exposed  | from another machine, `curl -m5 http://<IP>:4000` and `nc -zv <IP> 5432`         | both refused or timed out                    |

Market history starts empty on a new server. Pages that need several days of observations, such as the DCL range
backtest, show "not enough history yet" until they have them.

## Update or stop

- **Update:** build a new bundle, unpack it next to the old one, copy `.env` and `checkpoints/` across, then run
  `./setup.sh`. The database volume is kept.
- **Stop:** `docker compose down`. This keeps the data.
- **Delete everything:** `docker compose down -v`. This erases the database and the certificates.
