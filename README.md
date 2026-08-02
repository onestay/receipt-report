# Receipt Report

Receipt Report is a personal, self-hosted application for turning German grocery receipts into a searchable spending history. The usable AI MVP covers upload, normalization, extraction, human review and correction, approval, correction feedback, and spending reporting.

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

| Command                      | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `pnpm dev`                   | Start web, API, and worker in watch mode           |
| `pnpm build`                 | Create production builds for every package and app |
| `pnpm test`                  | Run unit and integration tests                     |
| `pnpm test:coverage`         | Run tests and enforce coverage thresholds          |
| `pnpm test:e2e`              | Build and run the Playwright smoke test            |
| `pnpm format`                | Format the repository with Prettier                |
| `pnpm format:check`          | Check formatting without modifying files           |
| `pnpm lint`                  | Run ESLint                                         |
| `pnpm typecheck`             | Run strict TypeScript checks                       |
| `pnpm compose:config`        | Validate the resolved Compose configuration        |
| `pnpm compose:smoke`         | Build and verify an isolated Compose deployment    |
| `pnpm compose:restore-drill` | Verify whole-volume backup/restore hashes          |

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

Before applying a migration to data you care about, stop API and worker writers
and back up the SQLite database with its WAL sidecars (or the complete Compose
volume). Category starters are a one-time migration data step: later deploys do
not recreate starter rows that a user renamed or deleted.

## Docker Compose

The commands below are for local development and synthetic verification. For a
real data-bearing deployment, pinned releases, backups, upgrades, provider
privacy, and the localhost-only security boundary, follow
[`docs/deployment.md`](docs/deployment.md).

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

## Production deployment

The production profile is intentionally different from the local Compose
stack: it uses explicitly selected API and worker images, stores the database
and document tree in one named volume, loads provider credentials only into the
worker, and publishes the unauthenticated application on localhost only.

```bash
git checkout <reviewed-release-tag-or-commit>
docker build --target api-runtime -t receipt-report-api:<release> .
docker build --target worker-runtime -t receipt-report-worker:<release> .
cp .env.production.example .env.production
chmod 600 .env.production
# Replace every placeholder and keep both image tags on the same release.

docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml up --detach --wait
curl --fail http://127.0.0.1:3000/api/v1/health
curl --fail http://127.0.0.1:3000/api/v1/operator/status
```

Do not expose port 3000 directly to the internet: Receipt Report is currently
single-user software without authentication. Before upgrades or model/profile
changes, follow the backup and rollback procedure in
[`docs/deployment.md`](docs/deployment.md). That guide also covers restore,
provider privacy, key rotation, retention, growth, and failure diagnosis.

## Configuration

Configuration is read from environment variables and validated at process
startup. An invalid value prevents the affected service from becoming ready.
Local development starts from [`.env.example`](.env.example); production
Compose starts from [`.env.production.example`](.env.production.example).
Values marked “required” have no application default in the relevant context.
Byte and time limits are integer bytes and milliseconds unless stated
otherwise.

### Service and storage

| Variable                  | Used by                 | Default     | Purpose                                                                                                                         |
| ------------------------- | ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                    | API                     | `127.0.0.1` | Address the API listens on. Production Compose fixes this to `0.0.0.0` inside the container and publishes it on host localhost. |
| `PORT`                    | API                     | `3000`      | API listen port inside a non-Compose deployment.                                                                                |
| `DATABASE_URL`            | API, worker, migrations | required    | SQLite `file:` URL. Production Compose fixes it to `file:/data/receipt-report.db`.                                              |
| `STORAGE_PATH`            | API, worker             | required    | Absolute, non-root document directory. It must be a dedicated subdirectory rather than the database directory.                  |
| `WEB_DIST_DIR`            | API                     | unset       | Built web assets served by the API. Production Compose uses `/app/apps/web/dist`.                                               |
| `WORKER_READY_FILE`       | worker                  | required    | File created only after worker startup checks pass and removed on graceful shutdown.                                            |
| `OPERATOR_STALE_AFTER_MS` | API                     | `900000`    | Age after which unchanged active normalization/extraction jobs count as stale in operator status.                               |

### Document validation and normalization

| Variable                         | Used by     | Default     | Purpose                                                                                                         |
| -------------------------------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `DOCUMENT_MAX_BYTES`             | API, worker | `26214400`  | Maximum uploaded document size (25 MiB).                                                                        |
| `DOCUMENT_MAX_REQUEST_BYTES`     | API, worker | `27262976`  | Maximum multipart request size; must exceed `DOCUMENT_MAX_BYTES`.                                               |
| `DOCUMENT_MAX_PDF_PAGES`         | API, worker | `100`       | Maximum accepted PDF page count.                                                                                |
| `DOCUMENT_MAX_IMAGE_WIDTH`       | API, worker | `20000`     | Maximum decoded image width in pixels.                                                                          |
| `DOCUMENT_MAX_IMAGE_HEIGHT`      | API, worker | `20000`     | Maximum decoded image height in pixels.                                                                         |
| `DOCUMENT_MAX_DECODED_PIXELS`    | API, worker | `200000000` | Maximum decoded pixel count accepted during validation.                                                         |
| `DOCUMENT_VALIDATION_TIMEOUT_MS` | API, worker | `5000`      | Upload validation deadline.                                                                                     |
| `NORMALIZATION_MAX_PAGE_PIXELS`  | API, worker | `16777216`  | Maximum pixels in one normalized page.                                                                          |
| `NORMALIZATION_MAX_TOTAL_PIXELS` | API, worker | `100000000` | Maximum pixels across all normalized pages; must be at least the per-page limit.                                |
| `NORMALIZATION_TIMEOUT_MS`       | API, worker | `120000`    | Renderer deadline for one document.                                                                             |
| `NORMALIZATION_MEMORY_MB`        | API, worker | `512`       | Memory ceiling supplied to the normalization renderer.                                                          |
| `NORMALIZATION_POLL_MS`          | API, worker | `500`       | Worker delay when no normalization work is available.                                                           |
| `NORMALIZATION_VERIFY_RENDERER`  | worker      | `true`      | Whether startup verifies required renderer tools. Local `.env.example` disables it for lightweight development. |

### Receipt extraction

| Variable                          | Used by     | Default                          | Purpose                                                                                                                                    |
| --------------------------------- | ----------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `EXTRACTION_PROVIDER`             | worker      | `fake`                           | `fake` for deterministic synthetic development/tests or `openai-compatible` for real extraction. Production explicitly selects the latter. |
| `EXTRACTION_BASE_URL`             | worker      | required for `openai-compatible` | HTTP(S) base URL whose `chat/completions` endpoint accepts the configured multimodal request.                                              |
| `EXTRACTION_MODEL`                | worker      | required for `openai-compatible` | Provider model identifier recorded with each attempt.                                                                                      |
| `EXTRACTION_API_KEY`              | worker      | required for `openai-compatible` | Provider bearer credential. Keep it only in the protected production env file; it is never passed to the API container.                    |
| `EXTRACTION_PROFILE_VERSION`      | API, worker | `de-receipt-v2`                  | Versioned extraction/profile contract. Only the currently supported value is accepted.                                                     |
| `EXTRACTION_TIMEOUT_MS`           | worker      | `60000`                          | Provider request deadline.                                                                                                                 |
| `EXTRACTION_MAX_PAGES`            | worker      | `10`                             | Maximum normalized pages sent in one provider request.                                                                                     |
| `EXTRACTION_MAX_IMAGE_BYTES`      | worker      | `20971520`                       | Maximum combined normalized-image bytes sent per request.                                                                                  |
| `EXTRACTION_MAX_RESPONSE_BYTES`   | worker      | `1048576`                        | Maximum provider response body retained/read before rejection.                                                                             |
| `EXTRACTION_POLL_MS`              | worker      | `500`                            | Worker delay when no extraction work is available.                                                                                         |
| `EXTRACTION_LEASE_MS`             | worker      | `120000`                         | Claim lease for extraction work; must exceed the provider timeout by at least 60 seconds.                                                  |
| `EXTRACTION_MAX_ATTEMPTS`         | API, worker | `5`                              | Automatic attempts permitted per extraction job (maximum 20).                                                                              |
| `EXTRACTION_RETRY_BASE_MS`        | worker      | `1000`                           | Initial retry backoff.                                                                                                                     |
| `EXTRACTION_RETRY_MAX_MS`         | worker      | `60000`                          | Maximum calculated retry backoff; must be at least the base value.                                                                         |
| `EXTRACTION_RETRY_AFTER_MAX_MS`   | worker      | `300000`                         | Maximum provider `Retry-After` delay that will be honored.                                                                                 |
| `EXTRACTION_RETRY_JITTER_PERCENT` | worker      | `20`                             | Random retry jitter from 0–100 percent.                                                                                                    |
| `EXTRACTION_RAW_RETENTION_MS`     | worker      | `604800000`                      | Retention period for raw provider output (seven days); audit metadata and validated proposals remain durable.                              |

### Structured logging

See [operational logging](docs/logging.md) for correlation fields, privacy
boundaries, Docker/jq queries, and investigation playbooks.

| Variable                        | Used by     | Default | Purpose                                                                                                                              |
| ------------------------------- | ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LOG_LEVEL`                     | API, worker | `info`  | Minimum JSON log level: `trace`, `debug`, `info`, `warn`, `error`, or `fatal`.                                                       |
| `LOG_SENSITIVE_PROVIDER_ERRORS` | worker      | `false` | Explicitly permits a capped 16 KiB non-2xx provider error body in console logs. This may contain sensitive provider or receipt data. |
| `LOG_SLOW_OPERATION_MS`         | API, worker | `1000`  | Positive duration threshold for slow database, storage, and provider-operation warnings.                                             |

### Production Compose selection

These variables are consumed by `compose.production.yaml`, not parsed by the
application itself.

| Variable                      | Default               | Purpose                                                                                           |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `RECEIPT_REPORT_API_IMAGE`    | required              | Immutable API runtime image tag or digest.                                                        |
| `RECEIPT_REPORT_WORKER_IMAGE` | required              | Immutable worker runtime image tag or digest from the same release as the API image.              |
| `RECEIPT_REPORT_DATA_VOLUME`  | `receipt-report-data` | Named volume containing SQLite, WAL state, originals, normalized pages, and audit/reporting data. |
| `RECEIPT_REPORT_PORT`         | `3000`                | Host-local port published as `127.0.0.1:<port>`.                                                  |
| `RECEIPT_REPORT_SECRETS_FILE` | `.env.production`     | Worker-only env file containing provider configuration and credentials.                           |

When adding, removing, renaming, changing the default of, or changing the
meaning of an environment variable, update the appropriate table above,
`packages/config`, every affected Compose file, and `.env.example` and/or
`.env.production.example` in the same pull request. Never put a real credential
or sensitive endpoint in an example file.

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
