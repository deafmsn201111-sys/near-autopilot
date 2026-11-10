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
- Visitor actions and `/api/prepare` are rate-limited per visitor ([`apps/analytics/lib/rate-limit.ts`](../../apps/analytics/lib/rate-limit.ts)).

The dashboard listens on `127.0.0.1:3000` of the server only. Postgres, the APIs and the collector are on the
internal Docker network. One of two front doors puts the dashboard on the internet over HTTPS:

| Front door           | When                                              | Address                                 |
| -------------------- | ------------------------------------------------- | --------------------------------------- |
| **Caddy**            | the server receives inbound ports 80 and 443      | `https://<IP>.sslip.io`, or your domain |
| **Tailscale Funnel** | behind a NAT, where only an SSH port is forwarded | `https://<machine>.<tailnet>.ts.net`    |

Both get a Let's Encrypt certificate, and both set the visitor's address themselves: a visitor cannot pass their own
`X-Forwarded-For` to dodge the per-visitor rate limit (checked for Funnel on 2026-11-08: a sent `X-Forwarded-For` is
replaced).

## Server

- Linux with Docker Engine and the Compose plugin.
- 2 vCPU, 4 GB RAM, about 10 GB of disk.
- Inbound SSH; for Caddy also ports 80 and 443. With 1 GB of RAM add 2 GB of swap: the five services use about
  330 MB at rest.

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
./setup.sh <server public IP>     # Caddy; or ./setup.sh with no argument for Tailscale Funnel
nano .env                         # MAINNET_READ_RPC_API_KEY=<your FastNEAR key>
./setup.sh                        # starts the stack
```

The first call loads the images and creates `.env` with a random database password, an API token and a **new**
audit checkpoint key pair. Nothing secret is printed.

- **With an IP** it turns Caddy on (`COMPOSE_PROFILES=caddy`) and sets `SITE_ADDRESS=<IP>.sslip.io`: a public DNS
  name that resolves to that IP, so Caddy can get a certificate without a domain of your own. To use your own domain,
  point it at the server and set `SITE_ADDRESS` to it.
- **Without an argument** there is no Caddy. Expose the dashboard with Tailscale Funnel:

  ```bash
  curl -fsSL https://tailscale.com/install.sh | sh
  tailscale up --hostname=near-autopilot-demo   # open the printed link and sign in
  tailscale funnel --bg 3000                    # the first time it prints a link to enable Funnel for the tailnet
  ```

  The address is printed by `tailscale funnel status`. The first request can take a minute while the certificate is
  issued, and the Funnel relays can take a few more minutes to all serve the new name.

Without a FastNEAR key, set `MAINNET_READ_RPC_URL=https://rpc.mainnet.near.org`. It is slower and rate-limited.

## 3. Check it

| Check            | Command or page                                                                  | Expected                                     |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| Containers       | `docker compose ps`                                                              | all `healthy`                                |
| Site             | the Caddy or Funnel address                                                      | the dashboard, with the "Public demo" banner |
| Collector cycles | `docker compose logs -f shadow-collector`                                        | a cycle every 15 minutes                     |
| Audit trail      | `docker compose exec analytics-api node --import tsx src/evidence/cli.ts verify` | chains and checkpoints `ok`                  |
| Nothing exposed  | `ss -tlnH` on the server                                                         | public: only SSH (and 80/443 with Caddy)     |

Market history starts empty on a new server. Pages that need several days of observations, such as the DCL range
backtest, show "not enough history yet" until they have them.

## Update or stop

- **Update:** build a new bundle, unpack it next to the old one, copy `.env` and `checkpoints/` across, then run
  `./setup.sh`. The database volume is kept.
- **Stop:** `docker compose down`. This keeps the data.
- **Delete everything:** `docker compose down -v`. This erases the database and the certificates.
