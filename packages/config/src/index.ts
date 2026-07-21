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
  })
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
});

const workerSchema = sharedSchema.extend({
  WORKER_READY_FILE: z.string().min(1),
  NORMALIZATION_VERIFY_RENDERER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export function parseApiConfig(input: NodeJS.ProcessEnv): ApiConfig {
  return apiSchema.parse(input);
}

export function parseWorkerConfig(input: NodeJS.ProcessEnv): WorkerConfig {
  return workerSchema.parse(input);
}
