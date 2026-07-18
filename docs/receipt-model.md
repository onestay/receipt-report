# Receipt domain model

This document captures concepts rather than a final database schema.

## Receipt

- Stable identifier
- Processing and review status
- Merchant name and optional address
- Purchase date and optional time
- Currency, initially EUR
- Subtotal, discounts, deposits, tax, and total when present
- Payment method when present
- Original model values and user-approved values
- Creation, processing, review, and update timestamps

## Receipt image

- Receipt identifier
- Stable relative storage path
- Media type, byte size, dimensions, and SHA-256 digest
- Page order for multi-image receipts

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

## Processing attempt

- Receipt and image references
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
