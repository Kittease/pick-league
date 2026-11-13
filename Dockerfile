# syntax=docker/dockerfile:1
# Multi-stage build for the server apps. Targets: `worker`, `api`.
#   docker build --target api -t pick-league-api .

FROM oven/bun:1.3.14-slim AS base
WORKDIR /app

# Only the workspace manifests + lockfile, so the install layer is cached until they change.
FROM base AS manifests
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock -delete && find . -type d -empty -delete

FROM base AS deps
COPY --from=manifests /app ./
RUN bun install --frozen-lockfile --production \
      --filter '@pick-league/worker' --filter '@pick-league/api'

FROM base AS source
ENV NODE_ENV=production
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages ./packages

FROM source AS worker
COPY apps/worker ./apps/worker
USER bun
CMD ["bun", "run", "apps/worker/src/index.ts"]

FROM source AS api
COPY apps/api ./apps/api
USER bun
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
