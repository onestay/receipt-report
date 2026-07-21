# Product definition

## Purpose

Receipt Report is a personal, self-hosted ledger for German grocery and retail
receipts. It should reduce manual entry while keeping every AI-generated value
reviewable and correctable.

## Primary workflow

1. A receipt arrives as an uploaded image or PDF. Email import will be added
   later and will feed the same ingestion pipeline.
2. A background worker normalizes its pages and sends them to a configured
   multimodal AI model.
3. The model extracts receipt fields and categorizes line items.
4. Deterministic validation checks totals, types, and structural consistency.
5. The user reviews uncertain or incorrect values and approves the receipt.
6. Approved data contributes to weekly and monthly reports.

## Initial scope

- Single user
- Self-hosted web application
- Versioned REST API suitable for a future mobile client
- German receipts, German terminology, and EUR
- Image and PDF upload with filesystem storage
- Configurable multimodal AI provider
- Editable receipt and line-item extraction
- Categories and correction rules
- Weekly and monthly spending summaries
- Search and basic filtering

## Later scope

- Email ingestion
- Additional AI providers
- Store-specific extraction hints
- Budgets, price history, and richer comparisons
- Mobile application

## Non-goals

- Multi-user SaaS or billing
- International receipt support in the initial release
- Training or fine-tuning a custom model
- Fully autonomous acceptance of model output
- Accounting, tax, or financial-advice functionality

## Product principles

- AI performs interpretation; deterministic code enforces invariants.
- Corrections must be quicker than entering a receipt manually.
- The original document and all of its pages remain available during review.
- User corrections take precedence over later reprocessing.
- Sensitive data remains under the operator's control, except when explicitly
  sent to the configured model provider.

## Manual merchant identity workflow

Manual receipt entry always keeps the printed or free-form merchant label as
the primary editable value. A user may additionally assign a canonical brand
and, once a brand is selected, one of its stores. The raw label remains what the
ledger leads with; canonical identity is shown separately for grouping and
future reporting.

Brands and stores can be created in place without discarding receipt edits.
Those merchant records are saved immediately and independently of the receipt.
Changing or clearing a brand while a store is selected requires an explicit
in-page confirmation because confirming also clears the incompatible store.
