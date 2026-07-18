# AI receipt processing

## Goal

A configurable multimodal model interprets a German receipt image and returns a
strict structured result. The model performs OCR, semantic extraction, and
initial item categorization in one processing step.

## Provider boundary

Application code depends on an internal interface conceptually equivalent to:

```ts
interface ReceiptModel {
  extract(input: ReceiptExtractionInput): Promise<ReceiptExtraction>;
}
```

Provider adapters are responsible for authentication, image encoding, structured
output configuration, rate limits, and mapping provider errors. Provider SDK
types must not leak into domain or API contracts.

## Pipeline

1. Verify and store the uploaded image.
2. Create a processing attempt and enqueue a job.
3. Build a request from the German profile, schema, and receipt images.
4. Call the configured provider.
5. Parse and validate the response with Zod.
6. Run deterministic domain validation and reconciliation.
7. Retry only for defined transient or repairable failures.
8. Save the proposed extraction for user review.
9. Preserve approved user corrections during any later reprocessing.

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
tests, if added, must be opt-in because they cost money and transmit images.
