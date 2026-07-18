FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
