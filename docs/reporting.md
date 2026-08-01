# Spending reporting

`GET /api/v1/reports/spending` requires inclusive `from` and `to` calendar
dates. Receipt dates are interpreted in the application's documented
`Europe/Berlin` timezone; no UTC conversion is applied to the stored date.
Amounts remain integer EUR cents.

The canonical receipt row is the sole financial source. A manually entered
receipt is included immediately. An AI proposal changes no amount until it is
approved; pending, rejected, and failed proposals are ignored. Receipts with no
approved proposal have `manual` provenance, one approved proposal has
`ai_approved`, and a later approved reprocessing has `ai_reprocessed`.

Gross, count, and rounded average are always returned. Net and tax totals are
nullable and sum only receipts whose canonical values are present; coverage
counts make partial data explicit. Empty ranges return zero gross/count and
null average/net/tax.

Monthly and merchant buckets use canonical receipt totals. Category buckets use
canonical line totals. Any difference between a receipt total and its line sum
is placed in an `unallocated-adjustment` bucket, so every breakdown reconciles
without inventing a category. `uncategorized` is distinct. Historical direct
assignments to a category that later became a parent are labeled explicitly;
subtree filtering selects direct and descendant assignments once and never
duplicates a receipt.

Breakdowns are ordered by descending cents, then label and stable key. Every
bucket provides a URL for the paginated receipt list with the equivalent
filters. The list and report accept date, category/subtree, merchant brand/store,
raw merchant, and approval-provenance filters.

`GET /api/v1/reports/workflow` separately counts current preparing, queued,
processing, needs-review, and failed receipt workflows. These operational counts
never carry amounts or filter financial totals.

SQLite uses the existing `Receipt_purchaseDate_id_idx` index for bounded date
ranges and stable receipt pagination. Category and merchant relations use their
existing foreign-key indexes. This is appropriate for a personal ledger; no new
index or backup/restore change is required.
