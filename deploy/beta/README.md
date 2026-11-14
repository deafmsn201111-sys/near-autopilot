# NEAR AI on beta

This config is an override for the VPS's existing isolated `near-autopilot-beta` stack. It is intentionally not part
of `deploy/public`; never apply it to the public/main stack.

## Configure the beta API key

Add these settings to the beta server's existing `deploy/beta/.env` (keep the file mode `600`):

```dotenv
NEAR_AI_API_KEY=<key from NEAR AI Cloud>
NEAR_AI_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017
NEAR_AI_MAX_TOKENS=4096
```

Do not put the key in Git, a command argument, or the browser. The model above is listed by the current NEAR AI Cloud
catalog with tool calling enabled. The application returns to its existing rule-based analysis when the key is empty.

## Start the beta API with NEAR AI

Copy `docker-compose.near-ai.yml` to the beta deployment folder, then run from that folder:

```bash
docker compose -p near-autopilot-beta \
  -f docker-compose.yml -f docker-compose.near-ai.yml \
  up -d --no-deps --force-recreate analytics-api
```

This command only recreates the beta API. Do not run it with the `near-autopilot-public` project.
