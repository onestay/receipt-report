# ADR 0013: Shape the extraction request for strict structured outputs

- Status: Accepted
- Date: 2026-08-01

## Context

The `openai-compatible` adapter sends its response schema as a `json_schema`
`response_format`. Providers behind that wire format do not accept the same
subset of JSON Schema. One provider compiles the schema strictly and rejects
numeric and string constraints, rejects an `enum` declared next to a union
`type`, caps a request at sixteen union-typed parameters, and refuses
`strict: false` outright. The original schema declared `minimum`, `maximum`,
`minLength`, nullable enums as union types, and thirty union-typed parameters,
so every request failed before the model ran. Those failures surface as
`provider_unavailable` with `retryable: false`, which sends a job directly to
`failed`.

Expressing bounds twice is not the problem. `receiptExtractionSchema` already
validates every reply independently, as ADR 0003 requires, so a request-side
keyword is a hint that narrows what the model may return, never the guarantee.

## Decision

Derive the request schema from the declared schema instead of sending it
verbatim. Keywords a strict provider rejects are stripped on the way out, so the
declaration keeps documenting intent while the wire stays acceptable. Nullable
enumerated values carry their null case inside the enum and omit `type`.
Confidence is enumerated as `0`, `0.25`, `0.5`, `0.75`, `1`, or null, which
keeps it inside the union budget because an enum does not count against it.
Date and time carry patterns matching the formats the domain schema accepts.

The lowest common denominator is sent to every provider rather than branching
per vendor. The adapter stays one code path, consistent with ADR 0003 keeping
provider-specific behavior isolated but not proliferating.

## Consequences

- Provider confidence is a coarse self-report of five levels rather than a
  continuous value. The review UI keeps its low-confidence boundary at `0.7`,
  which still separates the levels cleanly.
- Bounds are enforced once, on the reply. A provider that would have honored a
  stripped keyword now returns a wider value that Zod rejects as
  `malformed_response`, trading a provider-side rejection for a local one.
- Adding a nullable field costs one of sixteen union slots, so a future field
  may need the enum encoding rather than a union type.
- The encoding is driven by the strictest provider observed, so a provider with
  different rules may need the boundary revisited rather than extended here.
