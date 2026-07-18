import { z } from "zod";

const sharedSchema = z.object({
  DATABASE_URL: z.string().startsWith("file:"),
  STORAGE_PATH: z.string().min(1),
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
