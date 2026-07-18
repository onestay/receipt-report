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
receipt image storage
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
- Receipt images are stored on a mounted filesystem. SQLite stores metadata and
  stable relative paths, not image blobs.

## Persistence

SQLite is the primary database and should use WAL mode where deployment permits.
The database and receipt image directory must be mountable and backable up
together. Jobs begin as ordinary database records; no separate queue service is
needed for the initial workload.

## Trust boundaries

Images, email content, API requests, and model responses are untrusted. Zod
validates transport and model schemas. Domain validation separately verifies
receipt invariants such as totals, dates, quantities, and currency.

## Deployment

The intended installation uses Docker Compose with persistent volumes. The web
client, API, and worker may be separate containers, but should be built from the
same repository and version.
