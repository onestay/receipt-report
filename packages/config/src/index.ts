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
  });

const apiSchema = sharedSchema.extend({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  WEB_DIST_DIR: z.string().min(1).optional(),
});

const workerSchema = sharedSchema.extend({
  WORKER_READY_FILE: z.string().min(1),
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

export function parseApiConfig(input: NodeJS.ProcessEnv): ApiConfig {
  return apiSchema.parse(input);
}

export function parseWorkerConfig(input: NodeJS.ProcessEnv): WorkerConfig {
  return workerSchema.parse(input);
}
