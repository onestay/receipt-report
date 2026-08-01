# ADR 0015: Report only canonical receipt values

## Status

Accepted

## Decision

Financial reports read canonical receipts and line items, never proposal or
provider payload values. Proposal history is consulted only to classify approval
provenance. Operational extraction states are exposed by a separate amount-free
endpoint.

Incomplete net and tax data stays nullable with coverage counts. Category line
sums reconcile to receipt gross through an explicit unallocated adjustment
instead of silently changing either value.

## Consequences

Reports remain deterministic, cent-accurate, and stable across retries. Pending
AI work cannot alter financial results, while manually entered and historically
approved receipts retain explicit inclusion rules.
