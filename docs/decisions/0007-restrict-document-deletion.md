# ADR 0007: Restrict receipt-document deletion

- Status: Accepted
- Date: 2026-07-21

## Context

Receipt documents and normalized pages have metadata in SQLite but bytes on a
mounted filesystem. A database cascade cannot remove filesystem objects and
could silently orphan them. Deleting files first could instead lose the only
copy if the database operation then fails.

## Decision

Use restrictive foreign keys from receipt documents to receipts and from pages
to documents. A receipt carrying document metadata cannot be deleted until a
storage-aware removal operation explicitly coordinates file and row cleanup.
That removal policy is implemented with upload/replacement behavior rather than
as an incidental database cascade.

Document staging lives below the configured storage root. Promotion uses a
same-filesystem atomic rename, followed by metadata persistence; if persistence
fails, the promoted file is removed as compensating cleanup.

## Consequences

Ordinary receipt deletion is deliberately blocked while a document exists.
Future removal and replacement APIs must own cleanup and recovery explicitly.
Backups and restores must treat SQLite, WAL sidecars, and the document tree as a
single consistency unit.
