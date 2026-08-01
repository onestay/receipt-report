# ADR 0016: Durable real-data deployment boundary

- Status: Accepted
- Date: 2026-08-01

## Decision

The production Compose profile uses explicitly pinned API and worker images, a
single named volume for SQLite plus documents, localhost-only port binding, and
validated provider configuration. API and worker writers stop for a coherent
whole-volume backup before migrations. Rollback across an incompatible or
irreversible migration restores that backup instead of reversing migration SQL.

This release ends pre-production schema freedom. Every later migration must
preserve user data. Destructive schema rewrites are forbidden unless the change
includes an explicit, tested backup/restore migration plan. Each release must
document binary/schema compatibility and its rollback boundary.

The application remains unauthenticated single-user software. Localhost, an
authenticated VPN, or an SSH tunnel is an operational requirement, not a claim
of internet safety.

## Consequences

Database rows and filesystem documents are never backed up or restored
independently. Release images must move together. Backups include sensitive raw
provider responses while retained and need off-host protection and rotation.
The operator API exposes aggregate job health only; detailed receipt content and
secrets remain outside operational status surfaces.
