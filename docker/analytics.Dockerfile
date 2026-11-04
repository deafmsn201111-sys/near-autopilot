# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@near-autopilot/analytics..."
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @near-autopilot/analytics build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /repo
COPY --from=build --chown=node:node /repo/apps/analytics/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/analytics/.next/static ./apps/analytics/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "apps/analytics/server.js"]
