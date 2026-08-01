# AI receipt processing

Correction feedback from approved proposals stays local. Before/after values can
contain sensitive merchant and product text; they are part of SQLite backups and
are never sent to the extraction provider. Quality summaries read only this
local history. Exact category rules also stay local and are applied
deterministically after model output.

## Goal

A configurable multimodal model interprets a German receipt document and returns
a strict structured result. Initial inputs include common image formats and PDF.
The model performs OCR, semantic extraction, and initial item categorization in
one processing step.

## Provider boundary

Application code depends on an internal interface conceptually equivalent to:

```ts
interface ReceiptModel {
  extract(input: ReceiptExtractionInput): Promise<ReceiptExtraction>;
}
```

Provider adapters are responsible for authentication, page-image encoding,
structured output configuration, rate limits, and mapping provider errors.
Provider SDK types must not leak into domain or API contracts.

## Pipeline

1. Verify and store the uploaded image or PDF.
2. Normalize the document into ordered page images. A PDF is rendered locally;
   embedded text may be retained as supplemental input but is never trusted as
   the complete receipt representation.
3. Create a processing attempt and enqueue a job.
4. Build a request from the German profile, schema, and normalized pages.
5. Call the configured provider.
6. Parse and validate the response with Zod.
7. Run deterministic domain validation and reconciliation.
8. Retry only for defined transient or repairable failures.
9. Save the proposed extraction for user review.
10. Preserve approved user corrections during any later reprocessing.

Step 4 emits a schema a strict structured-output provider will compile. Such a
provider rejects numeric and string constraints, rejects an `enum` declared
next to a union type, and caps a request at sixteen union-typed parameters.
The request schema therefore omits keywords like `minimum` and `minLength`,
gives enumerated values their null case inside the enum rather than in a union
`type`, and enumerates confidence as one of `0`, `0.25`, `0.5`, `0.75`, `1`, or
null. Confidence is consequently a coarse provider self-report rather than a
continuous value. Removing a keyword from the request never weakens validation:
step 6 still enforces every bound, and the date and time fields additionally
carry patterns matching the formats the domain schema accepts, so the provider
constrains the reply instead of it failing after arrival.

Successful current attempts publish an editable proposal rather than updating
the receipt. Proposal findings are deterministic and stable-coded; provider
confidence is retained separately. Approval revalidates the edited snapshot,
requires explicit warning-code acknowledgement, and atomically compares the
receipt `updatedAt`, proposal state, and document revision before writing
canonical data. Rejecting or reprocessing never changes the canonical receipt.
Proposal and decision history is available through the versioned receipt API;
raw provider payloads remain excluded.

Normalization publication atomically creates one extraction job for its exact
normalization revision. Jobs use `pending`, `running`, `retry_wait`,
`succeeded`, `failed`, and `cancelled` states with conditional claim tokens and
expiring leases. Only rate limits, timeouts, and provider-unavailable failures
retry automatically; backoff, jitter, attempt count, lease duration, and a
bounded `Retry-After` hint are controlled by `EXTRACTION_*` settings. A worker
rechecks the document revision before publishing, so replacement, removal, or
a newer normalization can only leave an old attempt cancelled, never current.

Already-normalized documents are not mutated at startup. `POST
/api/v1/receipts/:id/document/extraction` is the explicit enqueue/backfill
action, `POST .../extraction/retry` retries a terminal failure, and `GET
.../extraction` returns sanitized lifecycle/provenance metadata. Ordinary API
responses never contain raw or validated model payloads.

Normalizing PDFs before the provider boundary keeps processing behavior
consistent even when a provider does not accept PDF files directly. Upload size,
page count, rendering resolution, and supported media types must be explicit,
configurable limits.

## Observability and reproducibility

Each attempt records the provider, model identifier, profile/prompt version,
timings, status, and validation findings. Sensitive raw responses and errors must
not be written indiscriminately to application logs.

## Configuration

Secrets are provided through environment variables. Non-secret settings should
include provider, model, base URL where applicable, retention behavior, retry
limits, and whether data may be sent outside the local network.

The first production adapter uses an OpenAI-compatible chat-completions
endpoint with structured JSON output. It is configured with
`EXTRACTION_PROVIDER=openai-compatible`, `EXTRACTION_BASE_URL`,
`EXTRACTION_MODEL`, and `EXTRACTION_API_KEY`. The timeout, extraction-only page
cap, combined normalized-image byte cap, response byte cap, and pinned profile
version use the corresponding `EXTRACTION_*` values in `.env.example`. The
default provider is `fake`, so merely starting the application never transmits
a receipt.

Configuring a remote provider means normalized receipt page images and the
minimal German extraction prompt leave the host and are processed under that
provider's privacy and retention terms. The local correction-rule database is
never included. API keys, authorization headers, page bytes, raw receipt
contents, and provider responses must not be written to normal logs or error
messages. Oversized documents fail locally before a provider request; the MVP
does not chunk them.

Raw provider output is protected only by whatever storage controls the host
provides and can make SQLite grow roughly in proportion to receipt count and
model response size. `EXTRACTION_RAW_RETENTION_MS` controls idempotent removal
of expired raw output. Attempt timing, outcome, provider/model/profile
provenance, and validated output remain for audit and later correction
feedback. SQLite, WAL sidecars, and the document tree remain one backup unit;
stop API and worker writers before backing it up or applying the extraction-job
migration. Restoring only the database or only the document tree can leave jobs
without their normalized page inputs.

Each explicit manual retry grants a new bounded automatic-attempt budget.
Repeated human retry actions can therefore extend a job's total lifetime even
though every individual automatic run remains capped.

## Browser review

Receipt list and detail screens expose preparing, queued, processing, needs
review, failed, and approved states. The browser polls only transient states,
pauses while hidden, and never replaces local proposal edits with a polling
response. Proposed fields and ordered lines stay visually separate from saved
canonical data. Findings move keyboard focus to affected fields, confidence is
advisory, and exact-rule category suggestions require explicit adoption.

Approval requires warning acknowledgement and the receipt concurrency token.
Rejecting edited proposals and reprocessing approved receipts require explicit
confirmation. Recoverable and stale failures preserve local edits, while
approved human data remains authoritative during later processing.

## Testing

Provider calls are replaced by deterministic fakes in ordinary tests. Contract
tests exercise adapters without requiring real receipt data. End-to-end provider
tests, if added, must be opt-in because they cost money and transmit receipt
pages.
