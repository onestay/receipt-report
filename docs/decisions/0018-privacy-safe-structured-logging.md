# ADR 0018: Privacy-safe structured operational logging

## Status

Accepted.

## Decision

API and worker processes emit Pino JSON events to standard output/error. The
container runtime owns collection, rotation, retention, shipping, and access.
Application components receive logger instances at their testable boundaries.

Every event has Pino's ISO timestamp and level plus `service`, stable `event`,
and `message`. Requests use a validated `request_id`; durable workers add opaque
job, attempt, and document identifiers where available. Log-only
`failure_stage`/`failure_detail` may preserve diagnostic distinctions without
changing persisted or public failure kinds.

Explicit safe serializers select error names and allowlisted system codes.
Bodies, credentials, prompts, receipt content, paths, hashes, claim tokens, SQL
parameters, and arbitrary client/network objects are excluded by default.
Non-2xx textual provider bodies may be retained under the existing bounded raw
response policy. They reach console logs only when
`LOG_SENSITIVE_PROVIDER_ERRORS=true`, capped at 16 KiB and prominently marked
as sensitive and possibly truncated. Successful output and validation-failing
2xx output never use that escape hatch.

## Consequences

Operators can correlate production failures using stable JSON fields without a
new metrics, tracing, or file-log subsystem. Enabling sensitive provider logging
requires protecting the container logs as receipt/provider data.
