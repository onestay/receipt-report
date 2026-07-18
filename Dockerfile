FROM node:24.18.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24.18.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.14.0 --activate
COPY --from=build /app /app
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @receipt-report/database db:migrate:deploy && pnpm --filter @receipt-report/api start"]
