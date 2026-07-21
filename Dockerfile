FROM node:24.18.0-bookworm-slim AS build-base
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
RUN mkdir /data && chown node:node /data

FROM build-base AS api-build
COPY . .
RUN pnpm install --frozen-lockfile --filter . --filter @receipt-report/api... --filter @receipt-report/web...
RUN pnpm --filter @receipt-report/config build \
    && pnpm --filter @receipt-report/contracts build \
    && pnpm --filter @receipt-report/database build \
    && pnpm --filter @receipt-report/api build \
    && pnpm --filter @receipt-report/web build

FROM build-base AS worker-build
COPY . .
RUN pnpm install --frozen-lockfile --filter . --filter @receipt-report/worker...
RUN pnpm --filter @receipt-report/config build \
    && pnpm --filter @receipt-report/contracts build \
    && pnpm --filter @receipt-report/database build \
    && pnpm --filter @receipt-report/worker build

FROM node:24.18.0-bookworm-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate

FROM runtime-base AS api-runtime
COPY --from=api-build /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM runtime-base AS worker-runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends poppler-utils util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=worker-build /app /app
USER node
CMD ["node", "apps/worker/dist/index.js"]
