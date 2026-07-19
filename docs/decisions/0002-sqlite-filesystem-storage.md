# ADR 0002: SQLite and filesystem storage

- Status: Accepted
- Date: 2026-07-18

## Context

Receipt Report is a single-user, self-hosted application with modest throughput.
Operating PostgreSQL or object storage would add complexity without a current
need.

## Decision

Use Prisma with SQLite for structured data and a mounted local directory for
original receipt images, PDFs, and normalized page images. Store stable relative
paths and document hashes in the database.

## Consequences

Deployment and backup are simple, but the database and document directory must
be backed up consistently. PDF rendering adds a local processing dependency and
derived page files. Multi-instance writes and horizontal scaling are not initial
design goals.

Before applying a database migration, stop writers and back up the SQLite file
(including any WAL sidecar) or the complete persistent volume. Migrations are
forward-only; recovery is restoration of that consistent pre-migration backup,
followed by redeployment of the previous application version.
