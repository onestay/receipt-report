# Receipt domain model

This document captures concepts rather than a final database schema.

## Receipt

- Stable identifier
- Processing and review status
- Merchant name and optional address
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
