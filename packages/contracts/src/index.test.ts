import { describe, expect, it } from "vitest";
import {
  healthResponseSchema,
  receiptCreateSchema,
  receiptDateSchema,
  receiptTimeSchema,
  receiptUpdateSchema,
} from "./index.js";

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
    merchant: "  Synthetic Markt  ",
    purchaseDate: "2026-07-19",
    totalCents: 1234,
    lineItems: [{ description: " Apfel ", lineTotalCents: 199 }],
  };
  it("normalizes valid input and defaults EUR", () => {
    expect(receiptCreateSchema.parse(valid)).toMatchObject({
      merchant: "Synthetic Markt",
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
    { ...valid, merchant: " " },
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
