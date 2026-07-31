# ADR 0010: Category learning is transparent exact-match advice

- Status: Accepted
- Date: 2026-07-31

## Context

Repeated manual category corrections should reduce future work, but fuzzy or
opaque learning can confidently repeat a wrong assignment. Receipt descriptions
also contain evidence and potentially sensitive purchase text that must not be
silently rewritten or sent elsewhere.

## Decision

Persist category suggestion rules as explicit exact-description mappings with a
global, brand, or store scope. Reuse the pinned German canonical normalization;
store beats brand, and brand beats global. Suggestions expose their rule and
scope, never mutate a line, and require explicit adoption and receipt saving.

Rule uniqueness is unconditional per normalized description and scope. A target
that drifts out of assignable state remains stored, visible, and unique but is
excluded from matching until repaired or deleted. Category and merchant
relations use restrictive deletion.

## Consequences

Behavior is predictable, inspectable, and reversible, at the cost of missing
near matches and requiring explicit confirmation when replacing an existing
rule. Product identity, fuzzy matching, and AI categorization remain separate
future concerns. Normalized descriptions remain local data unless a later,
explicitly configured AI request includes them.
