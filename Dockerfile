FROM node:20-bookworm-slim AS base
WORKDIR /app
ARG COREPACK_NPM_REGISTRY=https://registry.npmjs.org
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS deps
ARG npm_config_registry=https://registry.npmjs.org
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/authority-store/package.json packages/authority-store/
COPY packages/blob-store/package.json packages/blob-store/
COPY packages/config/package.json packages/config/
COPY packages/domain/package.json packages/domain/
COPY packages/dsh-connector/package.json packages/dsh-connector/
COPY packages/local-cli/package.json packages/local-cli/
COPY packages/plugin-host/package.json packages/plugin-host/
COPY packages/slack-connector/package.json packages/slack-connector/
COPY packages/whatsapp-personal/package.json packages/whatsapp-personal/
# Optional native accel for BullMQ; JS fallback is fine for the spike.
ENV npm_config_build_from_source=false
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm --filter @regenic/plugin-host build \
  && pnpm --filter @regenic/domain build \
  && pnpm --filter @regenic/config build \
  && pnpm --filter @regenic/blob-store build \
  && pnpm --filter @regenic/authority-store build \
  && pnpm --filter @regenic/dsh-connector build \
  && ls -la packages/authority-store/dist packages/blob-store/dist packages/config/dist packages/domain/dist \
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
