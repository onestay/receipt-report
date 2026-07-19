import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("receipt-report-api"),
  version: z.literal("v1"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const trimmedNonEmptyText = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

export const receiptIdSchema = z.string().cuid();
export const euroCentsSchema = z.number().int().safe().nonnegative();
export const quantityMilliSchema = z.number().int().safe().positive();
export const receiptDateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 0) - 1 &&
    date.getUTCDate() === day
  );
}, "Invalid calendar date");
export const receiptTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Invalid local time");

export const lineItemInputSchema = z
  .object({
    description: trimmedNonEmptyText,
    quantityMilli: quantityMilliSchema.nullish(),
    unitPriceCents: euroCentsSchema.nullish(),
    lineTotalCents: euroCentsSchema,
  })
  .strict();

export const lineItemSchema = lineItemInputSchema.extend({
  id: receiptIdSchema,
  position: z.number().int().nonnegative(),
});

export const receiptCreateSchema = z
  .object({
    merchant: trimmedNonEmptyText,
    purchaseDate: receiptDateSchema,
    purchaseTime: receiptTimeSchema.nullish(),
    currency: z.literal("EUR").default("EUR"),
    notes: z
      .string()
      .transform((value) => value.trim())
      .nullish(),
    totalCents: euroCentsSchema,
    lineItems: z.array(lineItemInputSchema).default([]),
  })
  .strict();

export const receiptUpdateSchema = z
  .object({
    merchant: trimmedNonEmptyText.optional(),
    purchaseDate: receiptDateSchema.optional(),
    purchaseTime: receiptTimeSchema.nullish(),
    currency: z.literal("EUR").optional(),
    notes: z
      .string()
      .transform((value) => value.trim())
      .nullish(),
    totalCents: euroCentsSchema.optional(),
    lineItems: z.array(lineItemInputSchema).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required",
  );

const receiptBaseSchema = z.object({
  id: receiptIdSchema,
  merchant: z.string().min(1),
  purchaseDate: receiptDateSchema,
  purchaseTime: receiptTimeSchema.nullable(),
  currency: z.literal("EUR"),
  notes: z.string().nullable(),
  totalCents: euroCentsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const receiptSummarySchema = receiptBaseSchema.extend({
  lineItemCount: z.number().int().nonnegative(),
});
export const receiptDetailSchema = receiptBaseSchema.extend({
  lineItems: z.array(lineItemSchema),
});
export const receiptListSchema = z.object({
  receipts: z.array(receiptSummarySchema),
  nextCursor: z.string().nullable(),
});
export const receiptListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().min(1).optional(),
});

export const apiErrorCodeSchema = z.enum([
  "validation_error",
  "invalid_cursor",
  "not_found",
  "internal_error",
]);
export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type LineItemInput = z.infer<typeof lineItemInputSchema>;
export type LineItem = z.infer<typeof lineItemSchema>;
export type ReceiptCreate = z.infer<typeof receiptCreateSchema>;
export type ReceiptUpdate = z.infer<typeof receiptUpdateSchema>;
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;
export type ReceiptList = z.infer<typeof receiptListSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
