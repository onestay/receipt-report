# Receipt domain model

This document captures concepts rather than a final database schema.

## Merchant identity

Merchant identity is three distinct concepts, not one string.

- **Canonical merchant brand** — the user-facing group spending is reported
  under, for example `EDEKA` or `REWE`. Stable identifier, display name, and a
  unique normalized name.
- **Store** — an optional specific location belonging to exactly one brand, for
  example `EDEKA Müller`, with optional structured street, postal code, and
  city fields.
- **Raw merchant label** — the exact text a user entered or a model extracted,
  for example `EDEKA M. Müller e.K.`, retained verbatim on the receipt after
  surrounding-whitespace normalization only.

A receipt always has a raw label and may additionally be linked to a brand, or
to a brand and a store. Both canonical links are nullable so unknown merchants
remain valid. A store link always carries its brand: the pair is validated at
the API boundary and a compound `(store, brand)` database relationship prevents
inconsistent direct writes. Clearing the brand clears the store in the same
update.

### Canonical-name normalization

Uniqueness and lookup use one deterministic function: Unicode NFC, trim,
collapse internal Unicode whitespace to a single ASCII space, then
`toLocaleLowerCase("de-DE")` with the locale pinned so the result does not vary
with runtime ICU defaults. Display spelling is preserved separately.

`ß` is deliberately **not** equated with `ss`, and diacritics are deliberately
**not** stripped: `Straße` and `Strasse`, and `Müller` and `Muller`, are
different merchants. Equating them would silently merge genuinely distinct
businesses, which is harder to undo than creating a duplicate.

### Store uniqueness

Stores carry a non-null normalized address key derived from the trimmed,
collapsed, and lowercased street, postal code, and city fields joined by a
separator that cannot occur in address text. Uniqueness is
`(brandId, normalized display name, normalized address key)`. Same-name stores
at different known addresses are therefore allowed, while two address-less
stores with the same name within a brand must be disambiguated by display name.

### Deletion policy

Deletion is restrictive. A brand with stores or linked receipts cannot be
deleted, and a store linked from a receipt cannot be deleted. No delete
cascades or silently unlinks canonical identity, because a receipt losing its
merchant grouping is a silent data loss the user cannot see.

## Receipt

- Stable identifier
- Processing and review status
- Raw merchant label, with optional canonical brand and store links
- Purchase date and optional time
- Currency, initially EUR
- Optional user notes
- Subtotal, discounts, deposits, tax, and total when present
- Payment method when present
- Original model values and user-approved values
- Creation, processing, review, and update timestamps

## Receipt document

- Receipt identifier
- Stable relative path to the original uploaded image or PDF
- Media type, byte size, and SHA-256 digest
- Original filename when available, stored only after sanitization
- Normalization status, sanitized failure code, requested/started/completed
  timestamps, profile version, and renderer identity

There is initially one retained original per receipt. Exact digest-and-size
uniqueness is enforced across the whole store. Attaching a second original is a
conflict unless the caller uses the explicit replacement operation. Replacement
promotes the new file and durably repoints metadata before retryable cleanup of
the old path. Explicit removal durably clears metadata before retryable file
cleanup; ordinary receipt deletion remains restricted while a document exists.

## Receipt page

- Receipt document identifier
- Stable relative path to the normalized page image
- Page number and total page count
- Media type, byte size, dimensions, and SHA-256 digest
- Normalization profile version and renderer identity

Images normally produce one normalized page. PDFs may produce multiple ordered
pages. The original file is retained while page images provide a consistent
input for review and AI providers.

Normalization jobs are intentionally single-purpose. There is at most one per
document, and a conditional pending-to-running claim with a unique generation
token prevents concurrent or stale workers from publishing competing page sets.
Only stale claims beyond the render deadline and publication grace are reclaimed.
Files are revisioned while one database transaction replaces the ordered page
rows, so partial sets are never public. The original always remains retained
when normalization fails.

## Line item

- Raw printed description
- Normalized display name
- Quantity and unit when present
- Unit price and line total
- Discount or deposit semantics when applicable
- One optional stable category identifier
- Model confidence or warnings
- User-correction state

All monetary values must use integer minor units in domain and persistence code.
Floating-point numbers must not be used for money.

In the manual ledger, quantity is an optional positive integer in thousandths
(`quantityMilli`), and ordered line items are persisted by their zero-based
position. Quantity, unit price, line total, and receipt total are independently
entered; reconciliation belongs to a later review workflow.
Canonical line amounts are signed integer cents. Every line has one explicit
kind: `item`, `discount`, `return`, `deposit`, `deposit_refund`, or `unknown`.
Existing manual rows migrate to `item`; AI proposals start at `unknown`, and a
more specific kind is accepted only through explicit review. Receipt gross,
net, and tax totals remain non-negative; optional net and tax values preserve
missing as `null` rather than coercing it to zero.

The manual editor treats the explicit receipt total and the integer sum of line
totals as separate user-entered values. A discrepancy is visible but does not
block saving, and quantity or unit price never derives or validates a line total.

## Spending category

A category has a stable identifier, editable display name, deterministic
normalized name, optional parent, sibling position, and optional archive
timestamp. The hierarchy is deliberately limited to top-level categories and
their direct children. Sibling names remain unique after normalization even
while archived, and positions are contiguous within each sibling set.

Leaf state is derived from the current child count rather than stored. Only an
effectively active leaf accepts a new line-item assignment: both the row and its
parent, if any, must be unarchived. Adding a first child leaves historical direct
assignments untouched but blocks new assignments to that parent. Removing or
moving away the final child makes it assignable again.

Archive state is independent per row. Archiving a parent disables its subtree
without changing child timestamps; restoring the parent re-enables children
that were not separately archived. A child cannot be restored while its parent
is archived. Deletion is restrictive for categories with children or line-item
references.

Fresh databases receive this ordinary, fully mutable taxonomy once through the
schema migration:

- Food → Fruit & vegetables, Meat & fish, Dairy & eggs, Bakery, Pantry &
  cooking, Snacks & sweets, Drinks, Alcohol
- Household → Cleaning, Paper goods, Home & kitchen supplies
- Personal care → Hygiene, Cosmetics, Hair care
- Eating out
- Health
- Pets
- Baby
- Clothing
- Electronics
- Other

The manual receipt workflow presents assignable children grouped by their
parent and standalone top-level leaves directly. `Uncategorized` represents a
null assignment, not a category row. An archived or formerly standalone parent
may remain visible on a historical line while being disabled for new
assignments. Bulk changes stay local until the whole receipt is saved, so a
failed save preserves every category and field edit together.

## Processing attempt

- Receipt, document, and page references
- Provider, model, and prompt/profile version
- Start and completion timestamps
- Status and sanitized error details
- Raw provider response, subject to a configurable retention policy
- Validated structured result and validation findings

## Categorization rule

Transparent category correction rules map one exact German-normalized line
description to one category at an explicit global, brand, or store scope. Store
rules take precedence over brand rules and brand rules over global rules. The
original receipt description is never rewritten.

A suggestion is UI advice only. An uncategorized line displays its current
suggestion and provenance, but adopting it requires an explicit action and the
ordinary receipt save. An existing explicit category always wins. Changing a
line description or receipt merchant identity recomputes only the displayed
suggestion and never clears or replaces a selected category.

Rules retain stable identity and unconditional uniqueness even if a target
category later becomes archived or non-leaf. Such a rule remains visible for
repair but produces no suggestion. Referenced categories, brands, and stores
cannot be deleted until the rule is repaired or removed.

Normalized rule descriptions may contain sensitive purchase text. They remain
in the local SQLite database unless a later, explicitly configured AI request
sends them. Product identity, preferred product names, catalogs, fuzzy matching,
and model-based categorization remain separate deferred work.

## German receipt considerations

Extraction and validation should account for decimal commas, multiple VAT
rates, `Pfand`, `Pfandrueckgabe`, weighted goods, negative discount lines,
abbreviated products, and common German payment descriptions. Store-specific
behavior belongs in versioned country or merchant profiles, not in UI code.
