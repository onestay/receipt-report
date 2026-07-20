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

const optionalTrimmedText = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value.length === 0 ? null : value))
  .nullish();

/**
 * Deterministic canonical form used for merchant uniqueness and lookup.
 *
 * Unicode NFC, trim, collapse internal Unicode whitespace to one ASCII space,
 * then lowercase with a pinned `de-DE` locale. `ß` is deliberately not equated
 * with `ss` and diacritics are deliberately preserved, so `Müller` and `Muller`
 * remain distinct merchants.
 */
export function normalizeMerchantName(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("de-DE");
}

/** Separator that cannot occur in user-entered address text. */
const addressKeySeparator = "\u001F";

/**
 * Non-null canonical address key. Each field is normalized like a display name
 * and absent fields become empty segments, so an address-less store has a
 * stable, comparable key rather than a null one.
 */
export function normalizeMerchantAddressKey(address: {
  street?: string | null | undefined;
  postalCode?: string | null | undefined;
  city?: string | null | undefined;
}): string {
  return [address.street, address.postalCode, address.city]
    .map((field) => (field ? normalizeMerchantName(field) : ""))
    .join(addressKeySeparator);
}

export const idSchema = z.string().cuid();
export const receiptIdSchema = idSchema;
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

const merchantAddressInputSchema = {
  street: optionalTrimmedText,
  postalCode: optionalTrimmedText,
  city: optionalTrimmedText,
};

export const merchantBrandCreateSchema = z
  .object({ name: trimmedNonEmptyText })
  .strict();
export const merchantBrandUpdateSchema = merchantBrandCreateSchema;

export const merchantStoreCreateSchema = z
  .object({
    brandId: idSchema,
    name: trimmedNonEmptyText,
    ...merchantAddressInputSchema,
  })
  .strict();

/** A store belongs to exactly one brand, so `brandId` is not updatable. */
export const merchantStoreUpdateSchema = z
  .object({
    name: trimmedNonEmptyText,
    ...merchantAddressInputSchema,
  })
  .strict();

export const merchantBrandSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  normalizedName: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const merchantStoreSchema = z.object({
  id: idSchema,
  brandId: idSchema,
  name: z.string().min(1),
  normalizedName: z.string().min(1),
  street: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  normalizedAddressKey: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const merchantListQuerySchema = z.object({
  query: z
    .string()
    .transform((value) => value.trim())
    .optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export const merchantStoreListQuerySchema = merchantListQuerySchema.extend({
  brandId: idSchema.optional(),
});

export const merchantBrandListSchema = z.object({
  brands: z.array(merchantBrandSchema),
  nextCursor: z.string().nullable(),
});
export const merchantStoreListSchema = z.object({
  stores: z.array(merchantStoreSchema),
  nextCursor: z.string().nullable(),
});

/**
 * Canonical links a client sends alongside the raw label. A store always
 * carries its brand so the pair can be validated at the boundary rather than
 * derived, and so clearing a brand cannot orphan a store link.
 */
const merchantLinkFields = {
  merchantBrandId: idSchema.nullish(),
  merchantStoreId: idSchema.nullish(),
};

function requiresBrandForStore(
  value: {
    merchantBrandId?: string | null | undefined;
    merchantStoreId?: string | null | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (value.merchantStoreId && !value.merchantBrandId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["merchantBrandId"],
      message: "merchantBrandId is required when merchantStoreId is set",
    });
  }
}

export const receiptCreateSchema = z
  .object({
    merchantRaw: trimmedNonEmptyText,
    ...merchantLinkFields,
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
  .strict()
  .superRefine(requiresBrandForStore);

export const receiptUpdateSchema = z
  .object({
    merchantRaw: trimmedNonEmptyText.optional(),
    ...merchantLinkFields,
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
  )
  .superRefine((value, context) => {
    const hasBrand = "merchantBrandId" in value;
    const hasStore = "merchantStoreId" in value;
    // Canonical identity moves as a unit: changing either link restates both,
    // so a partial update can never leave a store attached to another brand,
    // and clearing the brand necessarily clears the store.
    if (hasBrand !== hasStore) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasBrand ? "merchantStoreId" : "merchantBrandId"],
        message: "merchantBrandId and merchantStoreId must be updated together",
      });
      return;
    }
    requiresBrandForStore(value, context);
  });

/**
 * Canonical merchant data embedded in every receipt response so clients can
 * render the raw label and its grouping without a request per row.
 */
export const merchantBrandRefSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
});
export const merchantStoreRefSchema = merchantBrandRefSchema.extend({
  brandId: idSchema,
  street: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
});

const receiptBaseSchema = z.object({
  id: receiptIdSchema,
  merchantRaw: z.string().min(1),
  merchantBrand: merchantBrandRefSchema.nullable(),
  merchantStore: merchantStoreRefSchema.nullable(),
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
  "conflict",
  "internal_error",
]);
export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type MerchantBrandCreate = z.infer<typeof merchantBrandCreateSchema>;
export type MerchantBrandUpdate = z.infer<typeof merchantBrandUpdateSchema>;
export type MerchantBrand = z.infer<typeof merchantBrandSchema>;
export type MerchantBrandList = z.infer<typeof merchantBrandListSchema>;
export type MerchantStoreCreate = z.infer<typeof merchantStoreCreateSchema>;
export type MerchantStoreUpdate = z.infer<typeof merchantStoreUpdateSchema>;
export type MerchantStore = z.infer<typeof merchantStoreSchema>;
export type MerchantStoreList = z.infer<typeof merchantStoreListSchema>;
export type MerchantListQuery = z.infer<typeof merchantListQuerySchema>;
export type MerchantStoreListQuery = z.infer<
  typeof merchantStoreListQuerySchema
>;
export type LineItemInput = z.infer<typeof lineItemInputSchema>;
export type LineItem = z.infer<typeof lineItemSchema>;
export type ReceiptCreate = z.infer<typeof receiptCreateSchema>;
export type ReceiptUpdate = z.infer<typeof receiptUpdateSchema>;
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;
export type ReceiptList = z.infer<typeof receiptListSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
