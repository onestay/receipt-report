# AI receipt processing

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

## Testing

Provider calls are replaced by deterministic fakes in ordinary tests. Contract
tests exercise adapters without requiring real receipt data. End-to-end provider
tests, if added, must be opt-in because they cost money and transmit receipt
pages.
