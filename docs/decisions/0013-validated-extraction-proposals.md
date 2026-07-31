# ADR 0013: Separate extraction proposals from canonical receipts

## Status

Accepted

## Context

Model output is untrusted and may be incomplete, uncertain, internally
inconsistent, or stale by the time a user reviews it. Canonical receipt data
must remain usable during extraction and reprocessing, while later correction
feedback needs the original proposal and exact accepted edits.

## Decision

Every successful current extraction attempt creates an immutable-source
proposal for its exact document revision. The editable proposal snapshot,
stable-coded deterministic findings, provider confidence, and category-rule
suggestion provenance remain separate from the canonical receipt. A newer
proposal supersedes an older pending proposal, but never changes approved
receipt data.

Approval revalidates the complete submitted snapshot. Blocking findings reject
approval; every warning code present in that revalidation must be explicitly
acknowledged. The approval transaction compares the receipt `updatedAt`, the
proposal state, and the current document revision before replacing canonical
fields and line items. It records the original proposal, accepted snapshot,
field differences, warning acknowledgements, actor, and timestamp. Rejection
records a decision without changing the receipt. Reprocessing queues another
bounded attempt and leaves canonical data authoritative.

Canonical receipts gain nullable non-negative net and tax cents. Canonical line
amounts become signed integer cents with a bounded kind. Existing lines migrate
to `item`; AI proposal lines begin as `unknown`, and only an explicit accepted
snapshot assigns a more specific kind. Exact category rules produce
store-over-brand-over-global suggestions with rule provenance, but never assign
a category silently.

Proposal, finding, and decision relations use restrictive deletion. Once
history exists, document removal is rejected rather than silently erasing the
audit trail.

## Consequences

- Model completion and reprocessing cannot overwrite manual edits.
- Proposal and decision JSON intentionally duplicate snapshots for durable
  audit and later correction comparison, increasing SQLite size.
- `updatedAt` is the public optimistic-concurrency token; clients must submit
  the exact value they reviewed.
- Warning acknowledgement is per stable code, while informational confidence
  findings never masquerade as deterministic validation certainty.
- SQLite, WAL sidecars, and the document tree remain one coordinated backup
  and restore unit.
