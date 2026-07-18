# ADR 0002: SQLite and filesystem storage

- Status: Accepted
- Date: 2026-07-18

## Context

Receipt Report is a single-user, self-hosted application with modest throughput.
Operating PostgreSQL or object storage would add complexity without a current
need.

## Decision

Use Prisma with SQLite for structured data and a mounted local directory for
receipt images. Store stable relative paths and image hashes in the database.

## Consequences

Deployment and backup are simple, but the database and image directory must be
backed up consistently. Multi-instance writes and horizontal scaling are not
initial design goals.
