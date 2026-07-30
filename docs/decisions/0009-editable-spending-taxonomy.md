# ADR 0009: Editable two-level spending taxonomy

- Status: Accepted
- Date: 2026-07-30

## Context

Line-item reporting needs stable category identifiers and predictable parent
rollups, while a personal ledger must let its operator change the taxonomy.
Storing separate category and subcategory strings would make renames rewrite
receipt data, allow invalid combinations, and leave no stable report key.
Unbounded trees would add move, archive, assignment, and reporting complexity
that the initial product does not need.

A useful installation should not begin empty, but privileged or startup-upserted
starter rows would conflict with the promise that all categories are ordinary
user-owned data.

## Decision

Model one self-referencing `Category` resource with a nullable parent and enforce
exactly two levels. A parent target must be top-level, and a category with
children cannot be demoted. Categories have stable IDs, editable display and
normalized names, a contiguous position within their sibling set, and an
independent nullable archive timestamp. Sibling-name uniqueness includes
archived rows and uses the shared German normalization: NFC, trim, Unicode
whitespace collapse, then `toLocaleLowerCase("de-DE")`.

Leaf and effective-active state are derived. New line-item assignments may use
only a leaf whose own and parent archive timestamps are null. Adding the first
child preserves historical direct assignments while blocking new ones; moving
or deleting the last child makes the parent assignable again. Archiving a parent
does not rewrite child timestamps. Restoring a parent therefore re-enables only
children not archived independently, and restoring a child beneath an archived
parent is rejected.

Create appends, move optionally inserts at a target position, and reorder
restates a complete sibling order. Every mutation closes gaps and responses use
position followed by stable ID for deterministic ordering. Deletion is
restrictive when a category has children or line-item references.

Insert the initial taxonomy in one forward schema migration. Prisma's migration
ledger is the seeding guard; no application-startup upsert or reconciliation is
performed. Starter rows have no special marker or behavior after insertion.

## Consequences

Reports can roll a stable child ID into one predictable parent without coupling
to display spelling. Two levels cannot represent more elaborate taxonomies, but
avoids ambiguous assignment and lifecycle behavior. Historical lines may point
directly to a category that is no longer assignable; clients must display that
valid history without offering the category for a new choice.

Sibling moves and reorder operations require transactional position
normalization. Category deletion and name reuse can require an explicit
archive, reassignment, rename, or child move first. Backup and restore remain
unchanged operationally because categories and assignments live in the same
SQLite database as receipts; the database and document tree still form one
consistent backup unit.
