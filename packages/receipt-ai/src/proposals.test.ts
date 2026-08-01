import { describe, expect, it } from "vitest";
import {
  correctionComparisons,
  extractionToProposal,
  proposalDifferences,
  proposalSnapshotSchema,
  validateProposal,
} from "./proposals.js";
import { receiptExtractionSchema } from "./index.js";

function snapshot() {
  return proposalSnapshotSchema.parse({
    merchantRaw: "Synthetic Markt",
    merchantConfidence: 0.9,
    merchantBrandId: null,
    merchantStoreId: null,
    purchaseDate: "2026-07-31",
    purchaseDateConfidence: 0.9,
    purchaseTime: "12:34",
    purchaseTimeConfidence: 0.8,
    currency: "EUR",
    totalCents: 100,
    totalConfidence: 0.9,
    netCents: 80,
    taxCents: 20,
    lineItems: [
      {
        sourcePosition: 0,
        description: "Apfel",
        descriptionConfidence: 0.9,
        quantityMilli: 1000,
        unitPriceCents: 100,
        lineTotalCents: 100,
        categoryId: null,
        categorySuggestion: null,
        kind: "unknown",
      },
    ],
  });
}

function firstLine(value: ReturnType<typeof snapshot>) {
  const line = value.lineItems[0];
  if (!line) throw new Error("Missing proposal line fixture");
  return line;
}

describe("proposal validation", () => {
  it("maps present and missing extraction values without inventing confidence", () => {
    const absent = { value: null, confidence: null };
    const extraction = receiptExtractionSchema.parse({
      schemaVersion: "receipt-extraction-v1",
      profileVersion: "de-receipt-v1",
      merchantText: { value: "Markt", confidence: 0.8 },
      purchaseDate: { value: "2026-07-31", confidence: 0.9 },
      purchaseTime: absent,
      currency: { value: "EUR", confidence: 1 },
      grossTotalCents: { value: 100, confidence: 0.9 },
      netTotalCents: absent,
      taxTotalCents: absent,
      taxBreakdowns: [],
      lineItems: [
        {
          position: 0,
          description: { value: "Apfel", confidence: 0.8 },
          quantityMilli: absent,
          unit: absent,
          unitPriceCents: absent,
          lineTotalCents: { value: 100, confidence: 0.8 },
        },
      ],
      warnings: [],
    });
    expect(extractionToProposal(extraction)).toMatchObject({
      merchantRaw: "Markt",
      purchaseTime: null,
      netCents: null,
      lineItems: [
        { description: "Apfel", lineTotalCents: 100, kind: "unknown" },
      ],
    });
    const sourceLine = extraction.lineItems[0];
    if (!sourceLine) throw new Error("Missing extraction line fixture");
    const missing = receiptExtractionSchema.parse({
      ...extraction,
      merchantText: absent,
      purchaseDate: absent,
      currency: absent,
      grossTotalCents: absent,
      lineItems: [
        {
          ...sourceLine,
          description: absent,
          lineTotalCents: absent,
        },
      ],
    });
    expect(extractionToProposal(missing)).toMatchObject({
      merchantRaw: "",
      purchaseDate: "",
      currency: "EUR",
      totalCents: 0,
      lineItems: [{ description: "", lineTotalCents: 0 }],
    });
  });

  it("separates confidence information from deterministic findings", () => {
    const value = snapshot();
    value.merchantConfidence = 0.1;
    expect(validateProposal(value)).toContainEqual(
      expect.objectContaining({
        code: "low_confidence",
        severity: "info",
        fieldPath: "merchantRaw",
      }),
    );
  });

  it("addresses low confidence on dates, totals, and lines independently", () => {
    const value = snapshot();
    value.purchaseDateConfidence = 0.2;
    value.totalConfidence = 0.3;
    firstLine(value).descriptionConfidence = 0.4;
    expect(
      validateProposal(value)
        .filter((finding) => finding.code === "low_confidence")
        .map((finding) => finding.fieldPath),
    ).toEqual(["lineItems.0.description", "purchaseDate", "totalCents"]);
  });

  it("keeps missing optional tax and empty line sets valid", () => {
    const value = snapshot();
    value.netCents = null;
    value.taxCents = null;
    value.lineItems = [];
    expect(validateProposal(value)).toEqual([]);
  });

  it.each([
    [
      "required_merchant",
      (value: ReturnType<typeof snapshot>) => {
        value.merchantRaw = "";
      },
    ],
    [
      "invalid_purchase_date",
      (value: ReturnType<typeof snapshot>) => {
        value.purchaseDate = "2026-02-30";
      },
    ],
    [
      "invalid_purchase_time",
      (value: ReturnType<typeof snapshot>) => {
        value.purchaseTime = "25:00";
      },
    ],
    [
      "unsupported_currency",
      (value: ReturnType<typeof snapshot>) => {
        value.currency = "USD";
      },
    ],
    [
      "negative_receipt_total",
      (value: ReturnType<typeof snapshot>) => {
        value.taxCents = -1;
      },
    ],
    [
      "invalid_line_order",
      (value: ReturnType<typeof snapshot>) => {
        firstLine(value).sourcePosition = 2;
      },
    ],
    [
      "empty_line_description",
      (value: ReturnType<typeof snapshot>) => {
        firstLine(value).description = "";
      },
    ],
    [
      "duplicate_line_description",
      (value: ReturnType<typeof snapshot>) => {
        value.lineItems.push({
          ...firstLine(value),
          sourcePosition: 1,
          description: " APFEL ",
        });
        value.totalCents = 200;
      },
    ],
    [
      "line_sum_mismatch",
      (value: ReturnType<typeof snapshot>) => {
        value.totalCents = 500;
        value.netCents = null;
        value.taxCents = null;
      },
    ],
    [
      "tax_total_mismatch",
      (value: ReturnType<typeof snapshot>) => {
        value.taxCents = 18;
      },
    ],
    [
      "category_suggestion",
      (value: ReturnType<typeof snapshot>) => {
        firstLine(value).categorySuggestion = {
          categoryId: "clx0000000000000000000001",
          ruleId: "clx0000000000000000000002",
          scopeKind: "global",
        };
      },
    ],
  ])("emits stable code %s", (code, mutate) => {
    const value = snapshot();
    mutate(value);
    expect(validateProposal(value).map((finding) => finding.code)).toContain(
      code,
    );
  });

  it("uses cent-safe signed line arithmetic and one-cent tolerances", () => {
    const value = snapshot();
    value.lineItems = [
      { ...firstLine(value), lineTotalCents: 150, kind: "deposit" },
      {
        ...firstLine(value),
        sourcePosition: 1,
        lineTotalCents: -49,
        kind: "deposit_refund",
      },
    ];
    value.totalCents = 100;
    value.netCents = null;
    value.taxCents = null;
    expect(
      validateProposal(value).some(
        (finding) => finding.code === "line_sum_mismatch",
      ),
    ).toBe(false);
  });

  it("blocks an unsafe aggregate even when individual cents are safe", () => {
    const value = snapshot();
    value.lineItems = [
      { ...firstLine(value), lineTotalCents: Number.MAX_SAFE_INTEGER },
      { ...firstLine(value), sourcePosition: 1, lineTotalCents: 1 },
    ];
    value.netCents = null;
    value.taxCents = null;
    expect(validateProposal(value)).toContainEqual(
      expect.objectContaining({
        code: "unsafe_line_sum",
        severity: "blocking",
      }),
    );
  });

  it("produces deterministic correction differences", () => {
    const original = snapshot();
    const accepted = snapshot();
    accepted.totalCents = 101;
    expect(proposalDifferences(original, accepted)).toEqual([
      { path: "totalCents", proposed: 100, accepted: 101 },
    ]);
  });

  it("classifies field and conservative line-position feedback", () => {
    const original = snapshot();
    original.purchaseTime = null;
    firstLine(original).categoryId = "clx0000000000000000000001";
    const accepted = snapshot();
    accepted.purchaseTime = "12:35";
    firstLine(accepted).categoryId = null;
    firstLine(accepted).description = "Apfel rot";
    const comparisons = correctionComparisons(original, accepted);
    expect(comparisons).toContainEqual(
      expect.objectContaining({
        path: "purchaseTime",
        correctionKind: "missing_filled",
      }),
    );
    expect(comparisons).toContainEqual(
      expect.objectContaining({
        path: "lineItems.0.categoryId",
        sourcePosition: 0,
        correctionKind: "value_removed",
      }),
    );
    expect(comparisons).toContainEqual(
      expect.objectContaining({
        path: "lineItems.0.description",
        correctionKind: "changed",
      }),
    );
    expect(
      comparisons.find((item) => item.path === "merchantRaw"),
    ).toMatchObject({ correctionKind: "unchanged" });
    accepted.lineItems = [];
    expect(correctionComparisons(original, accepted)).toContainEqual(
      expect.objectContaining({
        path: "lineItems.0.description",
        accepted: null,
        correctionKind: "value_removed",
      }),
    );
  });
});
