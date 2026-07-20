# ADR 0006: Canonical merchant identity separate from raw labels

- Status: Accepted
- Date: 2026-07-20

## Context

Receipts carried a single free-form `merchant` string. That one field was doing
three jobs at once: recording what the receipt actually said, naming the store,
and standing in for the brand that spending should be grouped under. German
grocery receipts make the conflict concrete — `EDEKA M. Müller e.K.` is the
printed label, `EDEKA Müller` is the store, and `EDEKA` is the group a user
wants a report to total. Grouping by the raw string produces one bucket per
spelling variation; overwriting the raw string to make grouping work destroys
evidence of what the receipt said, which later AI extraction and review need.

Reporting also needs a canonical grouping that is a user-facing choice, not a
model of real-world corporate ownership, franchise agreements, or cooperative
structure.

## Decision

Model three separate concepts: a canonical merchant brand, an optional store
belonging to exactly one brand, and a raw label retained verbatim on each
receipt. Both canonical links on a receipt are nullable, so a receipt may be
raw-only, brand-only, or brand-plus-store.

Canonical names are compared through one deterministic normalization — NFC,
trim, whitespace collapse, `toLocaleLowerCase("de-DE")` — that deliberately
does not equate `ß` with `ss` and does not strip diacritics. Store uniqueness
includes a non-null normalized address key so that genuinely distinct locations
with the same name can coexist.

A store link always travels with its brand. The API validates the pair rather
than deriving the brand, and a compound `(id, brandId)` relationship enforces
consistency in the database so a direct Prisma write from a future worker cannot
bypass the check. Deletion is restrictive across the whole hierarchy.

Because the project is pre-production, the old `merchant` contract was removed
rather than aliased, and the migration mechanically moves existing values into
`merchantRaw`.

## Consequences

Grouping and raw evidence can evolve independently: correcting a brand never
rewrites what a receipt said, and merchant reporting has a stable key. Clients
must send both canonical IDs together and handle a `conflict` error code, which
is more work than a single free-text field.

Merchant assignment is manual at this stage. Automatic guessing, fuzzy matching,
alias learning from AI output, and merchant-management UI are deliberately left
to later issues, so early data may contain duplicate brands that differ only by
spelling. Restrictive deletion means cleaning those up requires relinking
receipts first, which is the intended trade-off: a merchant cannot disappear out
from under a receipt without someone deciding what should replace it.
