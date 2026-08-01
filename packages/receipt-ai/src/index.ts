import { z } from "zod";
import {
  euroCentsSchema,
  quantityMilliSchema,
  receiptDateSchema,
  receiptTimeSchema,
} from "@receipt-report/contracts";
export * from "./proposals.js";

export const EXTRACTION_SCHEMA_VERSION = "receipt-extraction-v1";
export const GERMAN_RECEIPT_PROFILE_VERSION = "de-receipt-v1";

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
    pages: z.array(normalizedPageSchema).min(1),
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

const signedCentsJsonSchema = { type: "integer" } as const;
const nonNegativeCentsJsonSchema = {
  type: "integer",
  minimum: 0,
} as const;
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
  ],
  properties: {
    position: { type: "integer", minimum: 0 },
    description: nullableFieldSchema({ type: "string", minLength: 1 }),
    quantityMilli: nullableFieldSchema({ type: "integer", minimum: 1 }),
    unit: nullableFieldSchema({
      type: "string",
      enum: ["piece", "kg", "g", "l", "ml", "unknown"],
    }),
    unitPriceCents: nullableFieldSchema(signedCentsJsonSchema),
    lineTotalCents: nullableFieldSchema(signedCentsJsonSchema),
  },
} as const;
const taxBreakdownJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rateBasisPoints", "netCents", "taxCents", "grossCents"],
  properties: {
    rateBasisPoints: nullableFieldSchema({
      type: "integer",
      minimum: 0,
      maximum: 10_000,
    }),
    netCents: nullableFieldSchema(nonNegativeCentsJsonSchema),
    taxCents: nullableFieldSchema(nonNegativeCentsJsonSchema),
    grossCents: nullableFieldSchema(nonNegativeCentsJsonSchema),
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
    merchantText: nullableFieldSchema({ type: "string", minLength: 1 }),
    // Patterns mirror receiptDateSchema/receiptTimeSchema so the provider
    // constrains the reply instead of it failing validation on arrival.
    purchaseDate: nullableFieldSchema({
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    }),
    purchaseTime: nullableFieldSchema({
      type: "string",
      pattern: "^([01]\\d|2[0-3]):[0-5]\\d$",
    }),
    currency: nullableFieldSchema({ type: "string", const: "EUR" }),
    grossTotalCents: nullableFieldSchema({ type: "integer", minimum: 0 }),
    netTotalCents: nullableFieldSchema({ type: "integer", minimum: 0 }),
    taxTotalCents: nullableFieldSchema({ type: "integer", minimum: 0 }),
    taxBreakdowns: { type: "array", items: taxBreakdownJsonSchema },
    lineItems: { type: "array", items: lineItemJsonSchema },
    warnings: { type: "array", items: { type: "string" } },
  },
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

function classifyStatus(response: Response): ReceiptExtractionError {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const { status } = response;
  if (status === 401 || status === 403)
    return new ReceiptExtractionError("authentication", false);
  if (status === 429)
    return new ReceiptExtractionError("rate_limit", true, retryAfterMs);
  return new ReceiptExtractionError(
    "provider_unavailable",
    status >= 500,
    status >= 500 ? retryAfterMs : undefined,
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
  return {
    name: "openai-compatible",
    async extract(input) {
      const request = extractionRequestSchema.parse(input);
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
                    { type: "text", text: "Extrahiere diesen Kassenbeleg." },
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
                  schema: providerJsonSchema,
                },
              },
            }),
            signal: controller.signal,
          },
        );
      } catch {
        clearTimeout(timeout);
        if (controller.signal.aborted)
          throw new ReceiptExtractionError("timeout", true);
        throw new ReceiptExtractionError("provider_unavailable", true);
      }
      let rawProviderOutput: string | undefined;
      try {
        if (!response.ok) throw classifyStatus(response);
        rawProviderOutput = await boundedResponseText(
          response,
          config.maxResponseBytes,
        );
        const envelope = z
          .object({
            choices: z
              .array(
                z.object({
                  message: z.object({ content: z.string() }),
                }),
              )
              .min(1),
          })
          .parse(JSON.parse(rawProviderOutput));
        const structured = receiptExtractionSchema.parse(
          JSON.parse(envelope.choices[0]?.message.content ?? ""),
        );
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
  options: { fakeResult?: ExtractionResult; fetch?: typeof fetch } = {},
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
