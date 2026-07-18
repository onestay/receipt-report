# Receipt Report

Receipt Report is a single-user, self-hosted foundation for importing, reviewing, and reporting on receipts. This initial scaffold provides the executable web, API, worker, database, testing, and container boundaries; receipt features intentionally come later.

## Requirements

- Node.js 24 (see `.nvmrc`)
- pnpm 11.14.0 through Corepack
- Docker with Compose v2 for container workflows

```bash
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

## Local development

The default configuration uses `.runtime/`, which is excluded from Git.

```bash
set -a
. ./.env
set +a
pnpm dev
```

The web app runs at <http://127.0.0.1:5173> and proxies same-origin `/api` requests to the API at port 3000. The worker creates its configured readiness file after database initialization and removes it on clean shutdown.

## Verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm compose:config
pnpm compose:smoke
```

Coverage HTML is written to `coverage/index.html`. Playwright writes failure traces, screenshots, and video to `test-results/` and its report to `playwright-report/`.

Every test run creates unique temporary SQLite and storage paths. Ordinary verification does not use developer data, secrets, paid providers, or public internet services.

## Containers

```bash
docker compose up --build --wait
curl --fail http://127.0.0.1:3000/api/v1/health
docker compose down
```

The API serves the built web bundle and both API and worker mount the `receipt-data` volume at `/data`. That volume holds the SQLite database and reserved document-storage root so they can be backed up together. Change the host port with `RECEIPT_REPORT_PORT=8080`.

The bounded smoke command creates an isolated Compose project, verifies service health and a real Prisma `SELECT 1`, then removes its test volume:

```bash
pnpm compose:smoke
```

## SQLite WAL fallback

API and worker request SQLite WAL mode on startup. Local filesystems and the Compose named volume support WAL. If a platform returns another journal mode, startup logs an explicit warning and continues; operators should move the database to a WAL-capable local filesystem. Network filesystems are not supported for the initial deployment.

## Production build

```bash
pnpm build
DATABASE_URL=file:./.runtime/production.db \
STORAGE_PATH=./.runtime/storage \
WEB_DIST_DIR=../web/dist \
pnpm --filter @receipt-report/api start
```

See `docs/architecture.md`, `docs/testing.md`, and `docs/agent-workflow.md` for the governing boundaries and review policy.

A personal, self-hosted application for turning German grocery receipts into a
searchable spending history. Receipt images and PDFs are processed by a
configurable multimodal AI provider, reviewed by the user, and summarized in
weekly and monthly reports.

This repository is currently in the planning and foundation phase. See
[`docs/product.md`](docs/product.md) for scope and [`docs/roadmap.md`](docs/roadmap.md)
for the intended delivery order.

## Intended stack

- TypeScript in a pnpm workspace
- React and Vite for the web client
- Express for the REST API
- Prisma with SQLite
- Zod for runtime validation and shared contracts
- A separate worker process for asynchronous receipt processing
- Local filesystem storage for receipt images and PDFs
- Vitest for unit and integration tests with enforced coverage thresholds
- Playwright for browser tests from the first user-facing workflow

The stack is recorded in [`docs/architecture.md`](docs/architecture.md). Changes
to foundational decisions should be captured in `docs/decisions/`.

Testing expectations are defined in [`docs/testing.md`](docs/testing.md).

## Development status

No application has been scaffolded yet. Work should be driven by small issues
with explicit acceptance criteria. Issues carrying the `agent-ready` label are
expected to be implementable without additional product decisions and to have
completed an independent Claude specification review. Implementation pull
requests receive Claude code review before merge so agents can cross-check one
another.

The complete handoff and cross-review process is documented in
[`docs/agent-workflow.md`](docs/agent-workflow.md).

## Data and privacy

This is a private, single-user application. Receipt documents and extracted data
may contain sensitive information. Secrets, receipt documents, databases, and
real email content must never be committed to Git.
