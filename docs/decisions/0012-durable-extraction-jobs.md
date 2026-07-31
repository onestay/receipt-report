# ADR 0012: Persist revision-fenced extraction jobs in SQLite

## Status

Accepted

## Context

AI extraction starts after document normalization and can outlive a worker
process, be rate-limited, or finish after a document has been replaced. The
system needs retryable work without a separate queue service, while preserving
provider provenance and preventing late results from overwriting a newer
document revision. Raw provider output is useful for short-term diagnosis but
contains receipt data and can grow the database substantially.

## Decision

Store extraction jobs and immutable attempt records in the existing SQLite
database. One job is identified by `(documentId, normalizationRevision)` and
pins both the normalization and extraction profile versions. Publishing a new
normalization revision atomically creates its pending extraction job and
cancels older active jobs.

Workers claim jobs with a conditional status update, unique claim token, and
expiring lease. Every completion transaction checks the current document
revision and the live claim token before publishing. An expired lease can be
reclaimed as a new attempt; a late worker cannot publish through its stale
token. Document replacement cancels active jobs, while document removal deletes
their attempts and jobs before deleting the document.

Only rate limits, timeouts, and provider-unavailable failures retry
automatically. Retries use capped exponential backoff with bounded jitter and a
bounded provider `Retry-After` hint. Each automatic run has a configured attempt
budget. An explicit manual retry grants another bounded budget, so repeated
human actions may deliberately extend a job's lifetime.

Attempt records retain sanitized failure kind, timing, provider, model,
profiles, and validated output. Raw provider output is never returned by the
ordinary API and is purged idempotently after a configured retention interval.
Existing normalized documents receive a stable legacy revision during
migration but are not silently enqueued; the API exposes an explicit backfill
operation.

## Consequences

- SQLite remains the only queue and audit store for the initial workload, with
  no broker or scheduler service to operate.
- SQLite, its WAL sidecars, and the document tree remain one coordinated backup
  and restore unit.
- Raw output is protected only by host storage controls until retention removes
  it; operators must account for temporary database growth and sensitive data.
- SQLite serializes claims adequately for the initial workload, but substantially
  higher concurrency may justify a dedicated queue or different database.
- Retry, lease, retention, and profile changes are explicit configuration or
  schema decisions rather than hidden worker behavior.
