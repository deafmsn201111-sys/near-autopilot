# NEAR AI on beta

This config is an override for the VPS's existing isolated `near-autopilot-beta` stack. It is intentionally not part
of `deploy/public`; never apply it to the public/main stack.

## Configure the beta API key

Add these settings to the beta server's existing `deploy/beta/.env` (keep the file mode `600`):

```dotenv
NEAR_AI_API_KEY=<key from NEAR AI Cloud>
NEAR_AI_MODEL=deepseek/deepseek-v4.1-flash
NEAR_AI_MAX_TOKENS=4096
```

Do not put the key in Git, a command argument, or the browser. The model above was confirmed live against NEAR AI Cloud
with tool calling enabled. The application returns to its existing rule-based analysis when the key is empty.

## Enable mobile WalletConnect

HOT Kit does not need an API key. To show WalletConnect for mobile EVM/TRON wallets, set `WALLETCONNECT_PROJECT_ID`
from the Reown dashboard in the beta server's `deploy/beta/.env`. This project id is public; the beta API exposes only
this id through `/api/public-config`. Without it, browser extension wallets and the other supported connectors remain
available, while WalletConnect choices stay hidden.

## Start the beta API with NEAR AI

Copy `docker-compose.near-ai.yml` to the beta deployment folder, then run from that folder:

```bash
docker compose -p near-autopilot-beta \
  -f docker-compose.yml -f docker-compose.near-ai.yml \
  up -d --no-deps --force-recreate analytics-api
```

This command only recreates the beta API. Do not run it with the `near-autopilot-public` project.
