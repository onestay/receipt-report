import { describe, expect, it } from "vitest";
import {
  healthResponseSchema,
  merchantStoreCreateSchema,
  merchantStoreUpdateSchema,
  normalizeMerchantAddressKey,
  normalizeMerchantName,
  receiptCreateSchema,
  receiptDateSchema,
  receiptTimeSchema,
  receiptUpdateSchema,
} from "./index.js";

/** Field separator used by the canonical address key. */
const separator = "\u001F";
const brandId = "clx0000000000000000000000";
const storeId = "clx1111111111111111111111";

describe("healthResponseSchema", () => {
  it("accepts the public health response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        service: "receipt-report-api",
        version: "v1",
      }),
    ).toEqual({
      status: "ok",
      service: "receipt-report-api",
      version: "v1",
    });
  });

  it("rejects an invalid status", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "down",
        service: "receipt-report-api",
        version: "v1",
      }),
    ).toThrow();
  });
});

describe("receipt contracts", () => {
  const valid = {
    merchantRaw: "  Synthetic Markt  ",
    purchaseDate: "2026-07-19",
    totalCents: 1234,
    lineItems: [{ description: " Apfel ", lineTotalCents: 199 }],
  };
  it("normalizes valid input and defaults EUR", () => {
    expect(receiptCreateSchema.parse(valid)).toMatchObject({
      merchantRaw: "Synthetic Markt",
      currency: "EUR",
      lineItems: [{ description: "Apfel" }],
    });
  });
  it("accepts leap dates and nullable optional fields", () => {
    expect(
      receiptCreateSchema.parse({
        ...valid,
        purchaseDate: "2028-02-29",
        purchaseTime: null,
        notes: null,
        lineItems: [],
      }),
    ).toMatchObject({
      purchaseDate: "2028-02-29",
      purchaseTime: null,
      notes: null,
    });
  });
  it.each(["2026-02-29", "2026-13-01", "19-07-2026"])(
    "rejects invalid date %s",
    (value) => expect(receiptDateSchema.safeParse(value).success).toBe(false),
  );
  it.each(["24:00", "9:00", "12:60"])("rejects invalid time %s", (value) =>
    expect(receiptTimeSchema.safeParse(value).success).toBe(false),
  );
  it.each([
    { ...valid, merchantRaw: " " },
    { ...valid, currency: "USD" },
    { ...valid, totalCents: -1 },
    { ...valid, totalCents: Number.MAX_SAFE_INTEGER + 1 },
    {
      ...valid,
      lineItems: [{ description: "x", lineTotalCents: 1, quantityMilli: 0 }],
    },
    { ...valid, unexpected: true },
  ])("rejects invalid create boundary %#", (value) =>
    expect(receiptCreateSchema.safeParse(value).success).toBe(false),
  );
  it("requires a meaningful patch while permitting empty item replacement", () => {
    expect(receiptUpdateSchema.safeParse({}).success).toBe(false);
    expect(receiptUpdateSchema.parse({ lineItems: [] })).toEqual({
      lineItems: [],
    });
  });
});

describe("merchant name normalization", () => {
  it("applies NFC, trims, collapses whitespace, and lowercases for de-DE", () => {
    expect(normalizeMerchantName("  EDEKA  M.\tMüller  ")).toBe(
      "edeka m. müller",
    );
  });

  it("equates precomposed and decomposed umlauts", () => {
    expect(normalizeMerchantName("Müller")).toBe(
      normalizeMerchantName("Müller"),
    );
  });

  it("keeps ß distinct from ss and preserves diacritics", () => {
    expect(normalizeMerchantName("Straße")).not.toBe(
      normalizeMerchantName("Strasse"),
    );
    expect(normalizeMerchantName("Müller")).not.toBe(
      normalizeMerchantName("Muller"),
    );
  });

  it("derives a stable address key that separates field boundaries", () => {
    expect(
      normalizeMerchantAddressKey({
        street: " Haupt straße 1 ",
        postalCode: "10115",
        city: "Berlin",
      }),
    ).toBe(["haupt straße 1", "10115", "berlin"].join(separator));
  });

  it("returns a non-null key for an address-less store", () => {
    expect(normalizeMerchantAddressKey({})).toBe(["", "", ""].join(separator));
  });

  it("does not let field shifts collide", () => {
    expect(
      normalizeMerchantAddressKey({ street: "A", postalCode: "B" }),
    ).not.toBe(normalizeMerchantAddressKey({ street: "A", city: "B" }));
  });
});

describe("merchant contracts", () => {
  it("trims store address fields and treats blanks as absent", () => {
    expect(
      merchantStoreCreateSchema.parse({
        brandId,
        name: "  EDEKA Müller  ",
        street: "  Hauptstraße 1 ",
        postalCode: "   ",
      }),
    ).toMatchObject({
      name: "EDEKA Müller",
      street: "Hauptstraße 1",
      postalCode: null,
    });
  });

  it("distinguishes an omitted address field from an explicit clear", () => {
    const patch = merchantStoreUpdateSchema.parse({
      name: "EDEKA Nord",
      city: null,
    });
    expect("city" in patch).toBe(true);
    expect(patch.city).toBeNull();
    expect("street" in patch).toBe(false);
  });

  it("requires a meaningful store patch", () => {
    expect(merchantStoreUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      merchantStoreUpdateSchema.safeParse({ city: "Berlin" }).success,
    ).toBe(true);
  });

  it("rejects a store without a brand", () => {
    expect(
      merchantStoreCreateSchema.safeParse({ name: "EDEKA Müller" }).success,
    ).toBe(false);
  });
});

describe("receipt merchant identity", () => {
  const base = {
    merchantRaw: "EDEKA M. Müller e.K.",
    purchaseDate: "2026-07-19",
    totalCents: 1234,
  };

  it("accepts raw-only, brand-only, and brand-plus-store identity", () => {
    expect(receiptCreateSchema.parse(base)).toMatchObject({
      merchantRaw: "EDEKA M. Müller e.K.",
    });
    expect(
      receiptCreateSchema.parse({ ...base, merchantBrandId: brandId }),
    ).toMatchObject({ merchantBrandId: brandId });
    expect(
      receiptCreateSchema.parse({
        ...base,
        merchantBrandId: brandId,
        merchantStoreId: storeId,
      }),
    ).toMatchObject({ merchantBrandId: brandId, merchantStoreId: storeId });
  });

  it("rejects a store without its brand on create", () => {
    expect(
      receiptCreateSchema.safeParse({ ...base, merchantStoreId: storeId })
        .success,
    ).toBe(false);
    expect(
      receiptCreateSchema.safeParse({
        ...base,
        merchantBrandId: null,
        merchantStoreId: storeId,
      }).success,
    ).toBe(false);
  });

  it("removes the old free-form merchant field", () => {
    expect(
      receiptCreateSchema.safeParse({
        merchant: "EDEKA",
        purchaseDate: "2026-07-19",
        totalCents: 1,
      }).success,
    ).toBe(false);
  });

  it("requires both canonical links to move together on update", () => {
    expect(
      receiptUpdateSchema.safeParse({ merchantBrandId: brandId }).success,
    ).toBe(false);
    expect(
      receiptUpdateSchema.safeParse({ merchantStoreId: null }).success,
    ).toBe(false);
    expect(
      receiptUpdateSchema.parse({
        merchantBrandId: null,
        merchantStoreId: null,
      }),
    ).toEqual({ merchantBrandId: null, merchantStoreId: null });
  });

  it("rejects clearing a brand while keeping a store", () => {
    expect(
      receiptUpdateSchema.safeParse({
        merchantBrandId: null,
        merchantStoreId: storeId,
      }).success,
    ).toBe(false);
  });
});
