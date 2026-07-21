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

Images normally produce one normalized page. PDFs may produce multiple ordered
pages. The original file is retained while page images provide a consistent
input for review and AI providers.

## Line item

- Raw printed description
- Normalized display name
- Quantity and unit when present
- Unit price and line total
- Discount or deposit semantics when applicable
- Category and optional subcategory
- Model confidence or warnings
- User-correction state

All monetary values must use integer minor units in domain and persistence code.
Floating-point numbers must not be used for money.

In the manual ledger, quantity is an optional positive integer in thousandths
(`quantityMilli`), and ordered line items are persisted by their zero-based
position. Quantity, unit price, line total, and receipt total are independently
entered; reconciliation belongs to a later review workflow.
Manual-ledger amounts are non-negative; modeling discounts, returns, and deposit
refunds as signed lines is intentionally deferred to the later extraction and
review domain.

The manual editor treats the explicit receipt total and the integer sum of line
totals as separate user-entered values. A discrepancy is visible but does not
block saving, and quantity or unit price never derives or validates a line total.

## Processing attempt

- Receipt, document, and page references
- Provider, model, and prompt/profile version
- Start and completion timestamps
- Status and sanitized error details
- Raw provider response, subject to a configurable retention policy
- Validated structured result and validation findings

## Categorization rule

A correction may create a reusable mapping from merchant and normalized receipt
text to a preferred product name and category. Explicit user choices override
model predictions.

## Initial category direction

- Groceries
- Drinks
- Alcohol
- Household
- Personal care
- Health
- Pet
- Baby
- Clothing
- Electronics
- Other

The exact taxonomy should be finalized in its own issue before being encoded in
database migrations.

## German receipt considerations

Extraction and validation should account for decimal commas, multiple VAT
rates, `Pfand`, `Pfandrueckgabe`, weighted goods, negative discount lines,
abbreviated products, and common German payment descriptions. Store-specific
behavior belongs in versioned country or merchant profiles, not in UI code.
