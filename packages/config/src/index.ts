import { z } from "zod";
import { dirname, isAbsolute, parse, resolve } from "node:path";

const safeStoragePath = z.string().superRefine((value, context) => {
  if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root) {
    context.addIssue({
      code: "custom",
      message: "STORAGE_PATH must be an absolute non-root directory",
    });
  }
});

const positiveLimit = z.coerce.number().int().positive();
const loggingSchema = z.object({
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_SENSITIVE_PROVIDER_ERRORS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  LOG_SLOW_OPERATION_MS: positiveLimit.default(1000),
});
const extractionProfileSchema = z.object({
  EXTRACTION_PROFILE_VERSION: z
    .literal("de-receipt-v2")
    .default("de-receipt-v2"),
});

const receiptAiSchema = z
  .object({
    EXTRACTION_PROVIDER: z.enum(["fake", "openai-compatible"]).default("fake"),
    EXTRACTION_BASE_URL: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        "EXTRACTION_BASE_URL must use HTTP or HTTPS",
      )
      .optional(),
    EXTRACTION_MODEL: z.string().min(1).optional(),
    EXTRACTION_API_KEY: z.string().min(1).optional(),
    EXTRACTION_PROFILE_VERSION:
      extractionProfileSchema.shape.EXTRACTION_PROFILE_VERSION,
    EXTRACTION_TIMEOUT_MS: positiveLimit.default(60_000),
    EXTRACTION_MAX_PAGES: positiveLimit.default(10),
    EXTRACTION_MAX_IMAGE_BYTES: positiveLimit.default(20 * 1024 * 1024),
    EXTRACTION_MAX_RESPONSE_BYTES: positiveLimit.default(1024 * 1024),
  })
  .superRefine((value, context) => {
    if (value.EXTRACTION_PROVIDER !== "openai-compatible") return;
    for (const key of [
      "EXTRACTION_BASE_URL",
      "EXTRACTION_MODEL",
      "EXTRACTION_API_KEY",
    ] as const) {
      if (!value[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required for openai-compatible extraction`,
        });
      }
    }
  });

const sharedSchema = z
  .object({
    DATABASE_URL: z.string().startsWith("file:"),
    STORAGE_PATH: safeStoragePath,
    DOCUMENT_MAX_BYTES: positiveLimit.default(25 * 1024 * 1024),
    DOCUMENT_MAX_PDF_PAGES: positiveLimit.default(100),
    DOCUMENT_MAX_IMAGE_WIDTH: positiveLimit.default(20_000),
    DOCUMENT_MAX_IMAGE_HEIGHT: positiveLimit.default(20_000),
    DOCUMENT_MAX_DECODED_PIXELS: positiveLimit.default(200_000_000),
    DOCUMENT_MAX_REQUEST_BYTES: positiveLimit.default(26 * 1024 * 1024),
    DOCUMENT_VALIDATION_TIMEOUT_MS: positiveLimit.default(5_000),
    NORMALIZATION_MAX_PAGE_PIXELS: positiveLimit.default(16_777_216),
    NORMALIZATION_MAX_TOTAL_PIXELS: positiveLimit.default(100_000_000),
    NORMALIZATION_TIMEOUT_MS: positiveLimit.default(120_000),
    NORMALIZATION_MEMORY_MB: positiveLimit.default(512),
    NORMALIZATION_POLL_MS: positiveLimit.default(500),
    EXTRACTION_MAX_ATTEMPTS: positiveLimit.max(20).default(5),
  })
  .safeExtend(loggingSchema.shape)
  .superRefine((value, context) => {
    const databasePath = value.DATABASE_URL.slice("file:".length);
    if (resolve(value.STORAGE_PATH) === dirname(resolve(databasePath))) {
      context.addIssue({
        code: "custom",
        path: ["STORAGE_PATH"],
        message:
          "STORAGE_PATH must be a dedicated subdirectory, not the database directory",
      });
    }
    if (value.DOCUMENT_MAX_REQUEST_BYTES <= value.DOCUMENT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_MAX_REQUEST_BYTES"],
        message: "DOCUMENT_MAX_REQUEST_BYTES must exceed DOCUMENT_MAX_BYTES",
      });
    }
    if (
      value.NORMALIZATION_MAX_TOTAL_PIXELS < value.NORMALIZATION_MAX_PAGE_PIXELS
    ) {
      context.addIssue({
        code: "custom",
        path: ["NORMALIZATION_MAX_TOTAL_PIXELS"],
        message:
          "NORMALIZATION_MAX_TOTAL_PIXELS must be at least NORMALIZATION_MAX_PAGE_PIXELS",
      });
    }
  });

const apiSchema = sharedSchema.extend({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_DIST_DIR: z.string().min(1).optional(),
  OPERATOR_STALE_AFTER_MS: positiveLimit.default(15 * 60 * 1000),
});

const workerSchema = sharedSchema
  .extend({
    WORKER_READY_FILE: z.string().min(1),
    EXTRACTION_POLL_MS: positiveLimit.default(500),
    EXTRACTION_LEASE_MS: positiveLimit.default(120_000),
    EXTRACTION_RETRY_BASE_MS: positiveLimit.default(1_000),
    EXTRACTION_RETRY_MAX_MS: positiveLimit.default(60_000),
    EXTRACTION_RETRY_AFTER_MAX_MS: positiveLimit.default(300_000),
    EXTRACTION_RETRY_JITTER_PERCENT: z.coerce
      .number()
      .int()
      .min(0)
      .max(100)
      .default(20),
    EXTRACTION_RAW_RETENTION_MS: positiveLimit.default(7 * 24 * 60 * 60 * 1000),
    NORMALIZATION_VERIFY_RENDERER: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
  })
  .superRefine((value, context) => {
    if (value.EXTRACTION_RETRY_MAX_MS < value.EXTRACTION_RETRY_BASE_MS) {
      context.addIssue({
        code: "custom",
        path: ["EXTRACTION_RETRY_MAX_MS"],
        message:
          "EXTRACTION_RETRY_MAX_MS must be at least EXTRACTION_RETRY_BASE_MS",
      });
    }
  });

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type ReceiptAiConfig = z.infer<typeof receiptAiSchema>;

export function parseApiConfig(input: NodeJS.ProcessEnv): ApiConfig {
  return apiSchema.parse(input);
}

export function parseWorkerConfig(input: NodeJS.ProcessEnv): WorkerConfig {
  return workerSchema.parse(input);
}

export function parseReceiptAiConfig(
  input: NodeJS.ProcessEnv,
): ReceiptAiConfig {
  return receiptAiSchema.parse(input);
}

export function parseReceiptAiProfileConfig(
  input: NodeJS.ProcessEnv,
): Pick<ReceiptAiConfig, "EXTRACTION_PROFILE_VERSION"> {
  return extractionProfileSchema.parse(input);
}
