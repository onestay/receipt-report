# ADR 0014: Keep correction feedback as local immutable comparisons

## Status

Accepted

## Context

Approved extraction proposals provide useful quality evidence, but purchase text
is sensitive and opaque automatic learning would make category behavior hard to
explain.

## Decision

Each approval stores one immutable comparison for every stable receipt field and
line field, keyed by the decision and field path. Comparisons retain proposal,
attempt, extraction-profile, provider, and model provenance. Line paths use only
the proposal position within that approval; they never infer product identity
across receipts.

Quality summaries are calculated from these records and can be filtered by
profile/model, date, and field kind. Exact-description category rules remain a
separate, deterministic local mechanism and are created only after an explicit
category interaction, scope choice, and confirmation.

Correction records and category rules are never included in provider requests.
They remain in SQLite, are included in database backups, and follow the
restrictive receipt/proposal deletion policy so audit provenance is not silently
lost.

## Consequences

Quality reports are reproducible and explainable without fine-tuning, fuzzy
matching, prompt mutation, or a product catalog. The database contains sensitive
before/after purchase text, so operators must protect backups and apply their
local retention policy to the whole database rather than deleting audit rows in
isolation.
