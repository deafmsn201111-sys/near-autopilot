# Public server

Runs the NEAR Autopilot site on a server over HTTPS. Services: `postgres`, `analytics-api`, `shadow-collector`,
`analytics` (the site) and, with the `caddy` profile, `caddy`.

**What it does:**

- reads NEAR mainnet with view calls only (the collector on a schedule, the analytics API for a connected account);
- analyses the two simulated demo portfolios ($500 and $5,000) as dry runs;
- builds an exact **unsigned** transaction cascade for a connected wallet. Wallet signing is on
  (`MAINNET_WALLET_SIGNING=1`): the visitor signs in their own wallet.

**What the server cannot do:** sign or send anything.

- The server holds no key, and the collector's executor is dry-run.
- Every cascade passes `apps/api/src/wallet/validate-cascade.ts` (0.15 NEAR per action, 0.3 NEAR per cascade).
- The network, the data source, the execution mode and `MAINNET_WALLET_SIGNING` are fixed in `docker-compose.yml`,
  not read from `.env`. The market and policy config is `config/market.json` (no secrets).
- Account lookups and `/api/prepare` are rate-limited per visitor, and account reads are cached for 60 s
  ([`apps/analytics/lib/rate-limit.ts`](../../apps/analytics/lib/rate-limit.ts); numbers and reasons in
  [`docs/DECISIONS.md`](../../docs/DECISIONS.md), D10).

The site listens on `127.0.0.1:3000` of the server only. Postgres, the analytics API and the collector are on the
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
- A firewall that lets in only SSH and, for Caddy, 80 and 443. As root, with your SSH port if it is not 22:

  ```bash
  ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
  ufw status numbered        # delete any other rule a hoster added, e.g. ufw delete allow 1500/tcp
  ```

  Docker-published ports bypass ufw, so the compose file publishes nothing else: the dashboard is on
  `127.0.0.1:3000`, Postgres and the API have no published port. Never publish one on `0.0.0.0`.

- Docker starts on boot (`systemctl enable docker`); every service has `restart: unless-stopped`, so the site comes
  back after a reboot. `setup.sh` keeps `.env` at `chmod 600`.
- A new secret goes into the `environment:` of only the services that use it, never into `x-common-env`.

## 1. Build the bundle (developer machine)

```bash
deploy/public/build-bundle.sh linux/amd64     # or linux/arm64 for an ARM server
```

The script:

- builds the images for that platform;
- checks that no `.env`, key or checkpoint file is inside them;
- writes `deploy/public/dist/near-autopilot-public-<commit>.tar.gz`.

The bundle holds the images, this folder and `config/market.json`. It contains no secrets.

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

Without a FastNEAR key, set `MAINNET_READ_RPC_URL=https://rpc.mainnet.near.org`. It is slower and rate-limited. With a
key, `MAINNET_READ_RPC_URL` must stay `https://rpc.mainnet.fastnear.com`: the public RPC ignores the key and answers
HTTP 429 under load.

## 3. Check it

| Check            | Command or page                                                                  | Expected                                 |
| ---------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| Containers       | `docker compose ps`                                                              | all `healthy`                            |
| Site             | the Caddy or Funnel address                                                      | the site                                 |
| Collector cycles | `docker compose logs -f shadow-collector`                                        | a cycle every 15 minutes                 |
| Audit trail      | `docker compose exec analytics-api node --import tsx src/evidence/cli.ts verify` | chains and checkpoints `ok`              |
| Nothing exposed  | `ss -tlnH` on the server                                                         | public: only SSH (and 80/443 with Caddy) |

Market history starts empty on a new server. Pages that need several days of observations, such as the DCL range
backtest, show "not enough history yet" until they have them.

## Backup and restore

A systemd timer runs [`backup.sh`](backup.sh) every night at 03:15: a `pg_dump` of the whole database to
`/opt/near-autopilot/backups/<date>.dump`, the 7 newest kept. The folder is outside the deploy folders, so a new
deploy keeps it. The dump runs inside the Postgres container, so it needs no password. Dumps hold `llm_calls`
(account ids, no IPs) and are gone after 7 days, the same as the LLM retention. There is no off-site copy.

Install once, as root, from the unpacked bundle:

```bash
install -m 700 backup.sh /opt/near-autopilot/backup.sh
cat > /etc/systemd/system/near-autopilot-backup.service <<'EOF'
[Service]
Type=oneshot
ExecStart=/opt/near-autopilot/backup.sh
EOF
cat > /etc/systemd/system/near-autopilot-backup.timer <<'EOF'
[Timer]
OnCalendar=*-*-* 03:15
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now near-autopilot-backup.timer
systemctl start near-autopilot-backup.service      # first dump now
```

| Task             | Command                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| Last dump        | `ls -lh /opt/near-autopilot/backups`                                                    |
| Last run, errors | `systemctl status near-autopilot-backup.service`, `journalctl -u near-autopilot-backup` |
| Next run         | `systemctl list-timers near-autopilot-backup.timer`                                     |

Restore one, from the deploy folder (stop the writers first, then start them again):

```bash
docker compose stop analytics-api shadow-collector
docker compose exec -T postgres pg_restore -U autopilot -d autopilot --clean --if-exists \
  < /opt/near-autopilot/backups/<date>.dump
docker compose start analytics-api shadow-collector
```

To check a dump without touching the live data, restore it into a scratch database and drop it:

```bash
docker compose exec -T postgres createdb -U autopilot scratch
docker compose exec -T postgres pg_restore -U autopilot -d scratch < /opt/near-autopilot/backups/<date>.dump
docker compose exec -T postgres psql -U autopilot -d scratch -c 'select count(*) from audit_events'
docker compose exec -T postgres dropdb -U autopilot scratch
```

## Uptime monitor

An outside service emails the owner when the site or the collector stops. On a free
[UptimeRobot](https://uptimerobot.com) account, 5-minute interval, alert by email:

| Monitor        | Type    | URL                                   | Alert when                        |
| -------------- | ------- | ------------------------------------- | --------------------------------- |
| Site           | HTTP(s) | `https://near-autopilot.tech/`        | not 2xx                           |
| Liveness       | HTTP(s) | `https://near-autopilot.tech/healthz` | not 2xx                           |
| API, collector | Keyword | `https://near-autopilot.tech/system`  | the page does not contain `Fresh` |

The home page and `/healthz` answer 200 even when the analytics API is down (the page shows the error inside). `/system`
shows `Fresh` only when the API answers and the collector's data is fresh, so the keyword monitor covers both.

## Update or stop

- **Update:** build a new bundle, unpack it next to the old one, copy `.env` and `checkpoints/` across, then run
  `./setup.sh`. The database volume is kept.
- **Stop:** `docker compose down`. This keeps the data.
- **Delete everything:** `docker compose down -v`. This erases the database and the certificates.
