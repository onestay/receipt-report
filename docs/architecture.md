# Architecture

## Shape

Receipt Report is an API-first TypeScript monorepo deployed as a small set of
processes from one codebase.

```text
React web client
       |
       v
Express REST API ---- SQLite
       |                 |
       v                 v
SQLite-backed jobs     metadata
       |
       v
worker ---- AI provider
       |
       v
receipt document storage
```

## Intended workspace

```text
apps/
  web/                 React + Vite
  api/                 Express REST API
  worker/              Background processing
packages/
  contracts/           Zod schemas and shared public types
  database/            Prisma schema and database access
  receipt-ai/          Provider adapters and extraction pipeline
  config/              Shared configuration
docs/
```

The precise workspace is established by a foundation issue rather than by this
planning commit.

## Boundaries

- The REST API is versioned under `/api/v1`.
- Public contracts live in `packages/contracts`, not in Prisma-generated types.
- The web client does not access the database directly.
- Model providers implement a small internal receipt extraction interface.
- The worker owns long-running model calls; HTTP requests enqueue work instead
  of waiting for extraction to finish.
- Original receipt images and PDFs are stored on a mounted filesystem. SQLite
  stores metadata and stable relative paths, not document blobs.
- PDFs and other multi-page inputs are normalized into ordered page images for
  review and provider-independent processing. The original PDF is retained.

## Public API surface

Versioned REST resources are flat rather than nested:

| Resource                        | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `/api/v1/receipts`              | Receipt CRUD and list                               |
| `/api/v1/merchant-brands`       | Canonical merchant brand CRUD and list              |
| `/api/v1/merchant-stores`       | Store CRUD and list, filtered by `brandId`          |
| `/api/v1/receipts/:id/document` | Original upload, metadata, replacement, and removal |

Both merchant lists accept a trimmed display-name `query`, a `limit`, and a
`cursor`, and are ordered by normalized name then stable ID so keyset
pagination is deterministic. Receipt responses embed the linked brand and store
so a client can render the raw label and its grouping without a request per row.

The public error taxonomy is `validation_error`, `invalid_cursor`, `not_found`,
`conflict`, document-ingestion errors, and `internal_error`. Document ingestion
uses stable `document_too_large`, `unsupported_document`, `malformed_document`,
`multipart_error`, and `duplicate_document` codes. A duplicate conflict includes
the existing receipt and document IDs. `conflict` (HTTP 409) covers normalized-name
collisions and referentially blocked deletion. A request naming an unknown or
mismatched brand/store is a `validation_error`, because the request itself is
wrong rather than the server state.

## Breaking-change policy

The project is pre-production and has no external consumers. Breaking schema and
API changes are made directly, without compatibility aliases or deprecation
windows, and synthetic development data may be discarded or migrated
mechanically. Migrations are still committed and must apply cleanly, so a
developer database can move forward without being recreated by hand. This policy
ends when the first real deployment carries data worth preserving.

## Persistence

SQLite is the primary database and should use WAL mode where deployment permits.
The database and receipt document directory must be mountable and backable up
together. Canonical merchant brands and stores live in the same SQLite database
as receipts, so an existing backup or restore covers merchant identity with no
additional step; a restore that predates a brand still referenced by a receipt
would fail its foreign key, so database and documents must be restored as one
consistent set. Jobs begin as ordinary database records; no separate queue service is
needed for the initial workload.

Receipt document storage uses a dedicated absolute, non-root directory distinct
from the SQLite file. Staging, retained originals, and normalized pages all live
below that root; staging on the same filesystem allows atomic rename when a file
is promoted. Paths stored in SQLite are generated relative paths and never
uploaded filenames. A receipt with document metadata is deletion-restricted
until a later storage-aware removal operation removes its files and metadata.
Uploads stream into a bounded staging file while computing SHA-256, and actual
JPEG, PNG, or PDF type and structure are checked without decoding pixels or
rendering PDF content. Exact `(SHA-256, byte size)` uniqueness is store-wide.
The initial bounded PDF validator intentionally accepts only PDFs whose page
objects and classic cross-reference table are visible in the file structure;
PDFs using compressed object/cross-reference streams are rejected until the
isolated normalization renderer in the next milestone becomes the definitive
parser. This conservative compatibility limit avoids decompressing or executing
PDF content in the API process.
Replacement promotes a new, separately named original before transactionally
repointing metadata; the old path is then cleaned through a durable retry record.
Removal first records cleanup and removes metadata transactionally, then deletes
bytes. Public document responses omit internal relative storage paths, and
original bytes are served only by receipt and document ID through the API.

In Compose, `/data/receipt-report.db` and `/data/documents` share the
`receipt-data` volume and therefore form one backup unit. Stop API and worker
writers before copying the complete volume (including SQLite WAL sidecars), and
restore the database and document tree together. The API and worker both need
write access: the API will stage/promote originals, while the worker publishes
derived pages. The migration container needs the database but does not receive
`STORAGE_PATH` or access document paths through application code.

## Trust boundaries

Images, PDFs, email content, API requests, and model responses are untrusted.
File signatures, size and page limits, and transport schemas must be validated.
Domain validation separately verifies receipt invariants such as totals, dates,
quantities, and currency.

## Deployment

The intended installation uses Docker Compose with persistent volumes. The web
client, API, and worker may be separate containers, but should be built from the
same repository and version.

## Verification architecture

- Vitest runs unit and integration tests across applications and packages.
- API and persistence integration tests use an isolated temporary SQLite
  database and real migrations rather than mocking the database boundary.
- AI and email integrations use deterministic fakes in ordinary CI.
- Playwright exercises the deployed web/API stack through the browser from the
  first user-facing workflow.
- Pull requests must pass formatting, linting, strict type checking,
  unit/integration coverage thresholds, production builds, and browser tests.

See `docs/testing.md` and ADR 0004 for the detailed strategy.
