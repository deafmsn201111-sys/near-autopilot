# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY . .
# Production dependencies of the API and every workspace package it uses (tsx is a runtime dependency).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@near-autopilot/api..."

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
