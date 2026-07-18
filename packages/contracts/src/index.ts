import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("receipt-report-api"),
  version: z.literal("v1"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
