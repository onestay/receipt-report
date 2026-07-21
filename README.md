# Receipt Report

Receipt Report is a personal, self-hosted application for turning German grocery receipts into a searchable spending history. It is currently an executable foundation: the web app, API, worker, SQLite database, tests, and container boundaries are in place; receipt ingestion and reporting workflows come next.

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm 11.14.0 through Corepack
- Docker with Compose v2 for container workflows

## Quick start

```bash
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env

# Apply the SQLite schema, then start web, API, and worker in watch mode
set -a; . ./.env; set +a
pnpm --filter @receipt-report/database db:migrate:deploy
pnpm dev
```

Open <http://127.0.0.1:5173>. Vite proxies same-origin `/api` requests to the API at <http://127.0.0.1:3000>. Local databases, documents, and worker state live under `.runtime/`, which Git ignores.

Stop all development processes with `Ctrl+C`.

## Common commands

| Command               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `pnpm dev`            | Start web, API, and worker in watch mode           |
| `pnpm build`          | Create production builds for every package and app |
| `pnpm test`           | Run unit and integration tests                     |
| `pnpm test:coverage`  | Run tests and enforce coverage thresholds          |
| `pnpm test:e2e`       | Build and run the Playwright smoke test            |
| `pnpm format`         | Format the repository with Prettier                |
| `pnpm format:check`   | Check formatting without modifying files           |
| `pnpm lint`           | Run ESLint                                         |
| `pnpm typecheck`      | Run strict TypeScript checks                       |
| `pnpm compose:config` | Validate the resolved Compose configuration        |
| `pnpm compose:smoke`  | Build and verify an isolated Compose deployment    |

Install Playwright's browser once before running E2E tests locally:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Coverage HTML is written to `coverage/index.html`. Playwright writes its report to `playwright-report/` and failure traces, screenshots, and videos to `test-results/`.

## Database commands

The default `.env` uses SQLite at `.runtime/development.db`.

```bash
# Regenerate the Prisma client after changing the schema
pnpm --filter @receipt-report/database db:generate

# Apply committed migrations
pnpm --filter @receipt-report/database db:migrate:deploy
```

API and worker processes request SQLite WAL mode when they start. If the filesystem cannot provide WAL, they emit a warning and continue; network filesystems are not supported for the initial deployment.

## Docker Compose

```bash
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/api/v1/health
docker compose down
```

Compose applies migrations once before starting the API and worker. The API serves the built web app at <http://127.0.0.1:3000>. Persistent database and document data lives in the `receipt-data` volume.

Use another host port if 3000 is occupied:

```bash
RECEIPT_REPORT_PORT=8080 docker compose up --build --wait
```

To remove the local Compose data volume as well as its containers:

```bash
docker compose down --volumes
```

## Production without Compose

```bash
pnpm install --frozen-lockfile
pnpm build

export DATABASE_URL=file:../../.runtime/production.db
export STORAGE_PATH="$PWD/.runtime/documents"
pnpm --filter @receipt-report/database db:migrate:deploy

WEB_DIST_DIR=../web/dist \
pnpm --filter @receipt-report/api start
```

Run the worker separately with the same database and storage configuration:

```bash
WORKER_READY_FILE=../../.runtime/worker.ready \
pnpm --filter @receipt-report/worker start
```

## Repository layout

```text
apps/
  api/          Express API and production web serving
  web/          React/Vite client
  worker/       Background worker process
packages/
  config/       Validated runtime configuration
  contracts/    Shared API contracts
  database/     Prisma schema, migrations, and SQLite helpers
  receipt-ai/   Provider-neutral AI integration boundary
docs/           Product, architecture, testing, and workflow documentation
scripts/        Repository automation and Compose smoke checks
```

Start with [`docs/product.md`](docs/product.md) for scope, [`docs/roadmap.md`](docs/roadmap.md) for delivery order, and [`docs/architecture.md`](docs/architecture.md) for system boundaries.

## Privacy

Receipt documents and extracted data may contain sensitive information. Never commit `.env` files, credentials, databases, real receipt documents, real email content, or sensitive logs. Automated tests use isolated SQLite files and synthetic, secret-free fixtures.
