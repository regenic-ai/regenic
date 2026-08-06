FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/domain/package.json packages/domain/
# Optional native accel for BullMQ; JS fallback is fine for the spike.
ENV npm_config_build_from_source=false
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @regenic/domain build \
  && pnpm --filter @regenic/config build \
  && ls -la packages/config/dist packages/domain/dist \
  && test -f packages/config/dist/index.d.ts \
  && test -f packages/domain/dist/index.d.ts \
  && pnpm --filter @regenic/api build \
  && pnpm --filter @regenic/worker build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app
EXPOSE 3000
CMD ["pnpm", "--filter", "@regenic/api", "start"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app
CMD ["pnpm", "--filter", "@regenic/worker", "start"]
