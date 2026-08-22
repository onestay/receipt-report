import { z } from "zod";
import {
  safeError,
  safeProviderOrigin,
  sensitiveBody,
  silentLogger,
  type Logger,
} from "@receipt-report/logging";
import {
  euroCentsSchema,
  quantityMilliSchema,
  receiptDateSchema,
  receiptTimeSchema,
} from "@receipt-report/contracts";
export * from "./proposals.js";

export const EXTRACTION_SCHEMA_VERSION = "receipt-extraction-v2";
export const GERMAN_RECEIPT_PROFILE_VERSION = "de-receipt-v2";

const signedCentsSchema = z.number().int().safe();
const nonNegativeCentsSchema = euroCentsSchema;
const confidenceSchema = z.number().finite().min(0).max(1);

/** Converts a provider decimal string to cents without binary-float rounding. */
export function decimalEurosToCents(value: string): number {
  const match = /^(-?)(\d+)(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new ReceiptExtractionError("malformed_response", false);
  const sign = match[1] === "-" ? -1 : 1;
  const euros = Number(match[2]);
  const fractional = (match[3] ?? "").padEnd(2, "0");
  const cents = euros * 100 + Number(fractional);
  if (!Number.isSafeInteger(cents)) {
    throw new ReceiptExtractionError("malformed_response", false);
  }
  return sign * cents;
}

function extractedField<T extends z.ZodType>(valueSchema: T) {
  return z
    .object({
      value: valueSchema.nullable(),
      confidence: confidenceSchema.nullable(),
    })
    .strict()
    .superRefine((field, context) => {
      const typedField = field as { value: unknown; confidence: number | null };
      if (typedField.value === null && typedField.confidence !== null) {
        context.addIssue({
          code: "custom",
          path: ["confidence"],
          message: "Missing values must not carry confidence",
        });
      }
      if (typedField.value !== null && typedField.confidence === null) {
        context.addIssue({
          code: "custom",
          path: ["confidence"],
          message: "Present values require confidence",
        });
      }
    });
}

export const extractedUnitSchema = z.enum([
  "piece",
  "kg",
  "g",
  "l",
  "ml",
  "unknown",
]);

export const extractedLineItemSchema = z
  .object({
    position: z.number().int().safe().nonnegative(),
    description: extractedField(z.string().trim().min(1)),
    quantityMilli: extractedField(quantityMilliSchema),
    unit: extractedField(extractedUnitSchema),
    unitPriceCents: extractedField(signedCentsSchema),
    lineTotalCents: extractedField(signedCentsSchema),
    categoryToken: extractedField(z.string().trim().min(1).max(8)).optional(),
  })
  .strict();

export const extractedTaxBreakdownSchema = z
  .object({
    rateBasisPoints: extractedField(
      z.number().int().safe().nonnegative().max(10_000),
    ),
    netCents: extractedField(nonNegativeCentsSchema),
    taxCents: extractedField(nonNegativeCentsSchema),
    grossCents: extractedField(nonNegativeCentsSchema),
  })
  .strict();

export const receiptExtractionSchema = z
  .object({
    schemaVersion: z.literal(EXTRACTION_SCHEMA_VERSION),
    profileVersion: z.literal(GERMAN_RECEIPT_PROFILE_VERSION),
    merchantText: extractedField(z.string().trim().min(1)),
    purchaseDate: extractedField(receiptDateSchema),
    purchaseTime: extractedField(receiptTimeSchema),
    currency: extractedField(z.literal("EUR")),
    grossTotalCents: extractedField(nonNegativeCentsSchema),
    netTotalCents: extractedField(nonNegativeCentsSchema),
    taxTotalCents: extractedField(nonNegativeCentsSchema),
    taxBreakdowns: z.array(extractedTaxBreakdownSchema),
    lineItems: z.array(extractedLineItemSchema),
    warnings: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict()
  .superRefine((result, context) => {
    result.lineItems.forEach((item, index) => {
      if (item.position !== index) {
        context.addIssue({
          code: "custom",
          path: ["lineItems", index, "position"],
          message: "Line item positions must be contiguous and zero-based",
        });
      }
    });
  });

export const normalizedPageSchema = z
  .object({
    position: z.number().int().safe().nonnegative(),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    bytes: z.instanceof(Uint8Array),
  })
  .strict()
  .refine((page) => page.bytes.byteLength > 0, "Page image must not be empty");

export const extractionRequestSchema = z
  .object({
    documentId: z.string().min(1),
    jobId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    pages: z.array(normalizedPageSchema).min(1),
    categoryOptions: z
      .array(
        z
          .object({
            token: z.string().regex(/^c\d{1,3}$/),
            categoryId: z.string().min(1),
            path: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    request.pages.forEach((page, index) => {
      if (page.position !== index) {
        context.addIssue({
          code: "custom",
          path: ["pages", index, "position"],
          message: "Page positions must be contiguous and zero-based",
        });
      }
    });
  });

export const extractionResultSchema = z
  .object({
    documentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    rawProviderOutput: z.string(),
    structured: receiptExtractionSchema,
  })
  .strict();

export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;
export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;
export type ExtractionCategoryOption = NonNullable<
  ExtractionRequest["categoryOptions"]
>[number];

export type ExtractionTotalReconciliation = {
  complete: boolean;
  lineTotalCents: number | null;
  grossDeltaCents: number | null;
};

export function reconcileExtractionTotals(
  extraction: ReceiptExtraction,
): ExtractionTotalReconciliation {
  const values = extraction.lineItems.map((line) => line.lineTotalCents.value);
  if (values.some((value) => value === null)) {
    return { complete: false, lineTotalCents: null, grossDeltaCents: null };
  }
  const lineTotalCents = values.reduce<number>(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  if (!Number.isSafeInteger(lineTotalCents)) {
    throw new ReceiptExtractionError("malformed_response", false);
  }
  const gross = extraction.grossTotalCents.value;
  return {
    complete: true,
    lineTotalCents,
    grossDeltaCents: gross === null ? null : lineTotalCents - gross,
  };
}

export const receiptExtractionErrorKinds = [
  "configuration",
  "authentication",
  "rate_limit",
  "timeout",
  "payload_too_large",
  "malformed_response",
  "provider_unavailable",
] as const;
export type ReceiptExtractionErrorKind =
  (typeof receiptExtractionErrorKinds)[number];

export class ReceiptExtractionError extends Error {
  readonly kind: ReceiptExtractionErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly rawProviderOutput: string | undefined;

  constructor(
    kind: ReceiptExtractionErrorKind,
    retryable: boolean,
    retryAfterMs?: number,
    rawProviderOutput?: string,
  ) {
    super(`Receipt extraction failed: ${kind}`);
    this.name = "ReceiptExtractionError";
    this.kind = kind;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.rawProviderOutput = rawProviderOutput;
  }
}

export type ReceiptExtractor = {
  readonly name: string;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
};

export const germanReceiptProfile = {
  version: GERMAN_RECEIPT_PROFILE_VERSION,
  systemPrompt: [
    "Du extrahierst strukturierte Daten aus deutschen EUR-Kassenbelegen.",
    "Erfinde keine unlesbaren oder fehlenden Werte.",
    "Setze value auf null und confidence auf null, wenn ein Wert fehlt oder nicht lesbar ist.",
    "Ein vorhandener unsicherer Wert braucht confidence zwischen 0 und 1.",
    "Geldwerte sind ganzzahlige Cent. Beleg-Gesamtsummen sind nicht negativ.",
    "Rabatte, Retouren und Pfandrueckgaben duerfen negative Zeilenbetraege haben.",
    "Positionen und Seiten sind nullbasiert und lueckenlos geordnet.",
    "Waehle categoryToken nur aus den bereitgestellten Kategorien; sonst value und confidence null.",
    "Antworte ausschliesslich mit dem angeforderten JSON-Objekt.",
  ].join(" "),
} as const;

/**
 * Discrete confidence levels. A `strict` schema is capped at 16 union-typed
 * parameters, and an enum is not counted as one — a `["number", "null"]` on
 * every extracted field would exhaust that budget on its own. Every level
 * still satisfies `confidenceSchema`.
 */
const confidenceJsonSchema = { enum: [0, 0.25, 0.5, 0.75, 1, null] } as const;

function nullableFieldSchema(
  valueSchema: Record<string, unknown> & { type: string },
) {
  const { type, enum: values, ...rest } = valueSchema;
  const enumerated = Array.isArray(values)
    ? [...values, null]
    : Object.hasOwn(valueSchema, "const")
      ? [valueSchema.const, null]
      : undefined;
  delete (rest as { const?: unknown }).const;
  // The provider rejects `enum` declared next to a union `type`, so enumerated
  // values carry the null case inside the enum and omit `type` entirely.
  const nullableValue = enumerated
    ? { ...rest, enum: enumerated }
    : { ...rest, type: [type, "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence"],
    properties: {
      value: nullableValue,
      confidence: confidenceJsonSchema,
    },
  };
}

/**
 * Extracted-field shapes, shared through `$defs`. The provider compiles a
 * `strict` schema into a grammar and rejects the whole document when every
 * field inlines its own copy of these seven shapes. Bounds are absent because
 * `stripUnsupportedJsonSchemaKeywords` removes them anyway, which is what lets
 * every integer field share one definition; `receiptExtractionSchema` still
 * enforces them when the reply is parsed.
 */
const fieldDefinitions = {
  nullableText: nullableFieldSchema({ type: "string" }),
  nullableInteger: nullableFieldSchema({ type: "integer" }),
  // Patterns mirror receiptDateSchema/receiptTimeSchema so the provider
  // constrains the reply instead of it failing validation on arrival.
  nullableDate: nullableFieldSchema({
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  }),
  nullableTime: nullableFieldSchema({
    type: "string",
    pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
  }),
  nullableCurrency: nullableFieldSchema({ type: "string", const: "EUR" }),
  nullableUnit: nullableFieldSchema({
    type: "string",
    enum: ["piece", "kg", "g", "l", "ml", "unknown"],
  }),
  nullableCategoryToken: nullableFieldSchema({ type: "string", enum: [] }),
} as const;

function fieldRef(name: keyof typeof fieldDefinitions) {
  return { $ref: `#/$defs/${name}` } as const;
}

const lineItemJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "position",
    "description",
    "quantityMilli",
    "unit",
    "unitPriceCents",
    "lineTotalCents",
    "categoryToken",
  ],
  properties: {
    position: { type: "integer", minimum: 0 },
    description: fieldRef("nullableText"),
    quantityMilli: fieldRef("nullableInteger"),
    unit: fieldRef("nullableUnit"),
    unitPriceCents: fieldRef("nullableInteger"),
    lineTotalCents: fieldRef("nullableInteger"),
    categoryToken: fieldRef("nullableCategoryToken"),
  },
} as const;
const taxBreakdownJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rateBasisPoints", "netCents", "taxCents", "grossCents"],
  properties: {
    rateBasisPoints: fieldRef("nullableInteger"),
    netCents: fieldRef("nullableInteger"),
    taxCents: fieldRef("nullableInteger"),
    grossCents: fieldRef("nullableInteger"),
  },
} as const;

const jsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "profileVersion",
    "merchantText",
    "purchaseDate",
    "purchaseTime",
    "currency",
    "grossTotalCents",
    "netTotalCents",
    "taxTotalCents",
    "taxBreakdowns",
    "lineItems",
    "warnings",
  ],
  properties: {
    schemaVersion: { const: EXTRACTION_SCHEMA_VERSION },
    profileVersion: { const: GERMAN_RECEIPT_PROFILE_VERSION },
    merchantText: fieldRef("nullableText"),
    purchaseDate: fieldRef("nullableDate"),
    purchaseTime: fieldRef("nullableTime"),
    currency: fieldRef("nullableCurrency"),
    grossTotalCents: fieldRef("nullableInteger"),
    netTotalCents: fieldRef("nullableInteger"),
    taxTotalCents: fieldRef("nullableInteger"),
    taxBreakdowns: { type: "array", items: taxBreakdownJsonSchema },
    lineItems: { type: "array", items: lineItemJsonSchema },
    warnings: { type: "array", items: { type: "string" } },
  },
  $defs: fieldDefinitions,
} as const;

/**
 * Keywords the provider rejects in a `strict` schema. The bounds they express
 * stay enforced by `receiptExtractionSchema` when the reply is parsed.
 */
const unsupportedJsonSchemaKeywords = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

function stripUnsupportedJsonSchemaKeywords(schema: unknown): unknown {
  if (Array.isArray(schema))
    return schema.map((entry) => stripUnsupportedJsonSchemaKeywords(entry));
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([keyword]) => !unsupportedJsonSchemaKeywords.has(keyword))
      .map(([keyword, value]) => [
        keyword,
        stripUnsupportedJsonSchemaKeywords(value),
      ]),
  );
}

const providerJsonSchema = stripUnsupportedJsonSchemaKeywords(jsonSchema);

function providerSchemaFor(categoryTokens: string[]): unknown {
  const schema = structuredClone(providerJsonSchema) as {
    $defs: {
      nullableCategoryToken: { properties: { value: { enum: unknown[] } } };
    };
  };
  schema.$defs.nullableCategoryToken.properties.value.enum = [
    ...categoryTokens,
    null,
  ];
  return schema;
}

export type OpenAiCompatibleExtractorConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxPages: number;
  maxImageBytes: number;
  maxResponseBytes: number;
  profileVersion: typeof GERMAN_RECEIPT_PROFILE_VERSION;
  fetch?: typeof fetch;
  logger?: Logger;
  logSensitiveProviderErrors?: boolean;
  logSlowOperationMs?: number;
};

export type ReceiptAiRuntimeConfig = {
  EXTRACTION_PROVIDER: "fake" | "openai-compatible";
  EXTRACTION_BASE_URL?: string | undefined;
  EXTRACTION_MODEL?: string | undefined;
  EXTRACTION_API_KEY?: string | undefined;
  EXTRACTION_PROFILE_VERSION: typeof GERMAN_RECEIPT_PROFILE_VERSION;
  EXTRACTION_TIMEOUT_MS: number;
  EXTRACTION_MAX_PAGES: number;
  EXTRACTION_MAX_IMAGE_BYTES: number;
  EXTRACTION_MAX_RESPONSE_BYTES: number;
  LOG_SENSITIVE_PROVIDER_ERRORS?: boolean;
  LOG_SLOW_OPERATION_MS?: number;
};

export function parseRetryAfterMs(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= nowMs) return undefined;
  const milliseconds = at - nowMs;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function classifyStatus(
  response: Response,
  rawProviderOutput?: string,
): ReceiptExtractionError {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const { status } = response;
  if (status === 401 || status === 403)
    return new ReceiptExtractionError(
      "authentication",
      false,
      undefined,
      rawProviderOutput,
    );
  if (status === 429)
    return new ReceiptExtractionError(
      "rate_limit",
      true,
      retryAfterMs,
      rawProviderOutput,
    );
  return new ReceiptExtractionError(
    "provider_unavailable",
    status >= 500,
    status >= 500 ? retryAfterMs : undefined,
    rawProviderOutput,
  );
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ReceiptExtractionError("malformed_response", false);
  }
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ReceiptExtractionError("malformed_response", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createOpenAiCompatibleReceiptExtractor(
  config: OpenAiCompatibleExtractorConfig,
): ReceiptExtractor {
  const protocol = URL.canParse(config.baseUrl)
    ? new URL(config.baseUrl).protocol
    : null;
  if (
    (protocol !== "http:" && protocol !== "https:") ||
    !config.model ||
    !config.apiKey ||
    config.profileVersion !== GERMAN_RECEIPT_PROFILE_VERSION ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs <= 0 ||
    !Number.isSafeInteger(config.maxPages) ||
    config.maxPages <= 0 ||
    !Number.isSafeInteger(config.maxImageBytes) ||
    config.maxImageBytes <= 0 ||
    !Number.isSafeInteger(config.maxResponseBytes) ||
    config.maxResponseBytes <= 0
  ) {
    throw new ReceiptExtractionError("configuration", false);
  }
  const transport = config.fetch ?? fetch;
  const logger = config.logger ?? silentLogger;
  const providerOrigin = safeProviderOrigin(config.baseUrl);
  return {
    name: "openai-compatible",
    async extract(input) {
      const request = extractionRequestSchema.parse(input);
      const correlation = {
        document_id: request.documentId,
        ...(request.jobId ? { job_id: request.jobId } : {}),
        ...(request.attemptId ? { attempt_id: request.attemptId } : {}),
      };
      const totalBytes = request.pages.reduce(
        (sum, page) => sum + page.bytes.byteLength,
        0,
      );
      if (
        request.pages.length > config.maxPages ||
        totalBytes > config.maxImageBytes
      ) {
        throw new ReceiptExtractionError("payload_too_large", false);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const providerStarted = performance.now();
      logger.info(
        {
          event: "provider.request.started",
          ...correlation,
          provider_origin: providerOrigin,
          model: config.model,
          page_count: request.pages.length,
          image_bytes: totalBytes,
          timeout_ms: config.timeoutMs,
        },
        "Provider request started",
      );
      let response: Response;
      try {
        response = await transport(
          new URL("chat/completions", ensureTrailingSlash(config.baseUrl)),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              temperature: 0,
              messages: [
                { role: "system", content: germanReceiptProfile.systemPrompt },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: [
                        "Extrahiere diesen Kassenbeleg.",
                        (request.categoryOptions ?? []).length
                          ? `Kategorien: ${(request.categoryOptions ?? []).map(({ token, path }) => `${token}: ${path}`).join("; ")}`
                          : "Keine Kategorien verfuegbar; categoryToken muss null sein.",
                      ].join(" "),
                    },
                    ...request.pages.map((page) => ({
                      type: "image_url",
                      image_url: {
                        url: `data:${page.mediaType};base64,${Buffer.from(page.bytes).toString("base64")}`,
                      },
                    })),
                  ],
                },
              ],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "german_receipt_extraction",
                  strict: true,
                  schema: providerSchemaFor(
                    (request.categoryOptions ?? []).map(
                      (option) => option.token,
                    ),
                  ),
                },
              },
            }),
            signal: controller.signal,
          },
        );
      } catch (error) {
        clearTimeout(timeout);
        if (controller.signal.aborted) {
          logger.warn(
            {
              event: "provider.request.failed",
              ...correlation,
              failure_stage: "provider_timeout",
              failure_kind: "timeout",
              duration_ms: Math.round(performance.now() - providerStarted),
            },
            "Provider request timed out",
          );
          throw new ReceiptExtractionError("timeout", true);
        }
        logger.warn(
          {
            event: "provider.request.failed",
            ...correlation,
            failure_stage: "provider_transport",
            failure_kind: "provider_unavailable",
            ...safeError(
              error instanceof Error && error.cause instanceof Error
                ? error.cause
                : error,
            ),
            duration_ms: Math.round(performance.now() - providerStarted),
          },
          "Provider transport failed",
        );
        throw new ReceiptExtractionError("provider_unavailable", true);
      }
      let rawProviderOutput: string | undefined;
      try {
        if (!response.ok) {
          try {
            rawProviderOutput = await boundedResponseText(
              response,
              config.maxResponseBytes,
            );
          } catch {
            rawProviderOutput = undefined;
          }
          const providerRequestId = [
            "x-request-id",
            "request-id",
            "openai-request-id",
          ]
            .map((name) => response.headers.get(name))
            .find(
              (value) =>
                value !== null && /^[A-Za-z0-9._-]{1,128}$/.test(value),
            );
          logger.warn(
            {
              event: "provider.request.completed",
              ...correlation,
              provider_origin: providerOrigin,
              http_status: response.status,
              duration_ms: Math.round(performance.now() - providerStarted),
              response_bytes:
                rawProviderOutput === undefined
                  ? null
                  : Buffer.byteLength(rawProviderOutput, "utf8"),
              retry_after_ms: parseRetryAfterMs(
                response.headers.get("retry-after"),
              ),
              ...(providerRequestId
                ? { provider_request_id: providerRequestId }
                : {}),
              ...(config.logSensitiveProviderErrors && rawProviderOutput
                ? sensitiveBody(rawProviderOutput)
                : {}),
            },
            "Provider returned an error response",
          );
          throw classifyStatus(response, rawProviderOutput);
        }
        try {
          rawProviderOutput = await boundedResponseText(
            response,
            config.maxResponseBytes,
          );
        } catch (error) {
          logger.warn(
            {
              event: "provider.response.failed",
              ...correlation,
              failure_stage: "provider_response_size",
              failure_kind: "malformed_response",
              ...safeError(error),
            },
            "Provider response exceeded the configured boundary",
          );
          throw error;
        }
        const providerDuration = Math.round(
          performance.now() - providerStarted,
        );
        logger[
          providerDuration >= (config.logSlowOperationMs ?? 1000)
            ? "warn"
            : "info"
        ](
          {
            event: "provider.request.completed",
            ...correlation,
            provider_origin: providerOrigin,
            http_status: response.status,
            duration_ms: providerDuration,
            response_bytes: Buffer.byteLength(rawProviderOutput, "utf8"),
          },
          "Provider request completed",
        );
        let envelopeValue: unknown;
        try {
          envelopeValue = JSON.parse(rawProviderOutput);
        } catch {
          logger.warn(
            {
              event: "provider.response.validation_failed",
              ...correlation,
              failure_stage: "provider_envelope_json",
              failure_kind: "malformed_response",
              issue_count: 1,
              issues: [{ path: "envelope", code: "invalid_json" }],
            },
            "Provider envelope JSON was invalid",
          );
          throw new ReceiptExtractionError(
            "malformed_response",
            false,
            undefined,
            rawProviderOutput,
          );
        }
        const envelopeSchema = z.object({
          choices: z
            .array(
              z.object({
                message: z.object({ content: z.string() }),
              }),
            )
            .min(1),
        });
        const parsedEnvelope = envelopeSchema.safeParse(envelopeValue);
        if (!parsedEnvelope.success) {
          logger.warn(
            {
              event: "provider.response.validation_failed",
              ...correlation,
              failure_stage: "provider_envelope_schema",
              failure_kind: "malformed_response",
              issue_count: parsedEnvelope.error.issues.length,
              issues: parsedEnvelope.error.issues.map((issue) => ({
                path: issue.path.join("."),
                code: issue.code,
              })),
            },
            "Provider envelope schema was invalid",
          );
          throw new ReceiptExtractionError(
            "malformed_response",
            false,
            undefined,
            rawProviderOutput,
          );
        }
        let extractionValue: unknown;
        try {
          extractionValue = JSON.parse(
            parsedEnvelope.data.choices[0]?.message.content ?? "",
          );
        } catch {
          extractionValue = undefined;
        }
        const parsedExtraction =
          receiptExtractionSchema.safeParse(extractionValue);
        if (!parsedExtraction.success) {
          logger.warn(
            {
              event: "provider.response.validation_failed",
              ...correlation,
              failure_stage: "extraction_schema",
              failure_kind: "malformed_response",
              issue_count: parsedExtraction.error.issues.length,
              issues: parsedExtraction.error.issues.map((issue) => ({
                path: issue.path.join("."),
                code: issue.code,
              })),
            },
            "Extracted receipt schema was invalid",
          );
          throw new ReceiptExtractionError(
            "malformed_response",
            false,
            undefined,
            rawProviderOutput,
          );
        }
        const structured = parsedExtraction.data;
        return extractionResultSchema.parse({
          documentId: request.documentId,
          provider: "openai-compatible",
          model: config.model,
          rawProviderOutput,
          structured,
        });
      } catch (error) {
        if (error instanceof ReceiptExtractionError) throw error;
        if (controller.signal.aborted)
          throw new ReceiptExtractionError("timeout", true);
        throw new ReceiptExtractionError(
          "malformed_response",
          false,
          undefined,
          rawProviderOutput,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function createConfiguredReceiptExtractor(
  config: ReceiptAiRuntimeConfig,
  options: {
    fakeResult?: ExtractionResult;
    fetch?: typeof fetch;
    logger?: Logger;
  } = {},
): ReceiptExtractor {
  if (config.EXTRACTION_PROVIDER === "fake") {
    return options.fakeResult
      ? createFakeReceiptExtractor(options.fakeResult)
      : createDeterministicFakeReceiptExtractor();
  }
  return createOpenAiCompatibleReceiptExtractor({
    baseUrl: config.EXTRACTION_BASE_URL ?? "",
    model: config.EXTRACTION_MODEL ?? "",
    apiKey: config.EXTRACTION_API_KEY ?? "",
    timeoutMs: config.EXTRACTION_TIMEOUT_MS,
    maxPages: config.EXTRACTION_MAX_PAGES,
    maxImageBytes: config.EXTRACTION_MAX_IMAGE_BYTES,
    maxResponseBytes: config.EXTRACTION_MAX_RESPONSE_BYTES,
    profileVersion: config.EXTRACTION_PROFILE_VERSION,
    logSensitiveProviderErrors: config.LOG_SENSITIVE_PROVIDER_ERRORS ?? false,
    logSlowOperationMs: config.LOG_SLOW_OPERATION_MS ?? 1000,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export function createDeterministicFakeReceiptExtractor(): ReceiptExtractor {
  return {
    name: "fake",
    async extract(input) {
      const request = extractionRequestSchema.parse(input);
      const absent = { value: null, confidence: null } as const;
      const structured = receiptExtractionSchema.parse({
        schemaVersion: EXTRACTION_SCHEMA_VERSION,
        profileVersion: GERMAN_RECEIPT_PROFILE_VERSION,
        merchantText: absent,
        purchaseDate: absent,
        purchaseTime: absent,
        currency: absent,
        grossTotalCents: absent,
        netTotalCents: absent,
        taxTotalCents: absent,
        taxBreakdowns: [],
        lineItems: [],
        warnings: ["deterministic_fake_output"],
      });
      return {
        documentId: request.documentId,
        provider: "fake",
        model: "deterministic-fake-v1",
        rawProviderOutput: JSON.stringify(structured),
        structured,
      };
    },
  };
}

export function createFakeReceiptExtractor(
  result: ExtractionResult,
): ReceiptExtractor {
  const validated = extractionResultSchema.parse(result);
  return {
    name: "fake",
    async extract(input) {
      const request = extractionRequestSchema.parse(input);
      if (request.documentId !== validated.documentId) {
        throw new Error("Fake result does not match the requested document");
      }
      return structuredClone(validated);
    },
  };
}
