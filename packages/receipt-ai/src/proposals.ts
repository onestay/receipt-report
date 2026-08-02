import {
  proposalSnapshotSchema,
  receiptDateSchema,
  receiptTimeSchema,
  type ProposalFinding,
  type ProposalSnapshot,
} from "@receipt-report/contracts";
import type { ReceiptExtraction } from "./index.js";

export { proposalSnapshotSchema };
export type { ProposalFinding, ProposalSnapshot };

export function extractionToProposal(
  extraction: ReceiptExtraction,
): ProposalSnapshot {
  return proposalSnapshotSchema.parse({
    merchantRaw: extraction.merchantText.value ?? "",
    merchantConfidence: extraction.merchantText.confidence,
    merchantBrandId: null,
    merchantStoreId: null,
    purchaseDate: extraction.purchaseDate.value ?? "",
    purchaseDateConfidence: extraction.purchaseDate.confidence,
    purchaseTime: extraction.purchaseTime.value,
    purchaseTimeConfidence: extraction.purchaseTime.confidence,
    currency: extraction.currency.value ?? "EUR",
    totalCents: extraction.grossTotalCents.value ?? 0,
    totalConfidence: extraction.grossTotalCents.confidence,
    netCents: extraction.netTotalCents.value,
    taxCents: extraction.taxTotalCents.value,
    lineItems: extraction.lineItems.map((line) => ({
      sourcePosition: line.position,
      description: line.description.value ?? "",
      descriptionConfidence: line.description.confidence,
      quantityMilli: line.quantityMilli.value,
      unitPriceCents: line.unitPriceCents.value,
      lineTotalCents: line.lineTotalCents.value ?? 0,
      lineTotalConfidence: line.lineTotalCents.confidence,
      categoryConfidence: line.categoryToken?.confidence ?? null,
      categoryId: null,
      categorySuggestion: null,
      categoryProvenance: null,
      kind: "unknown" as const,
    })),
  });
}

export function validateProposal(
  snapshot: ProposalSnapshot,
): ProposalFinding[] {
  const findings: ProposalFinding[] = [];
  const add = (
    code: string,
    severity: ProposalFinding["severity"],
    fieldPath: string | null,
    message: string,
  ) => findings.push({ code, severity, fieldPath, message });
  if (!snapshot.merchantRaw.trim())
    add("required_merchant", "blocking", "merchantRaw", "Merchant is required");
  if (!receiptDateSchema.safeParse(snapshot.purchaseDate).success)
    add(
      "invalid_purchase_date",
      "blocking",
      "purchaseDate",
      "Purchase date is invalid",
    );
  if (
    snapshot.purchaseTime !== null &&
    !receiptTimeSchema.safeParse(snapshot.purchaseTime).success
  )
    add(
      "invalid_purchase_time",
      "blocking",
      "purchaseTime",
      "Purchase time is invalid",
    );
  if (snapshot.currency !== "EUR")
    add("unsupported_currency", "blocking", "currency", "Currency must be EUR");
  for (const [field, value] of [
    ["totalCents", snapshot.totalCents],
    ["netCents", snapshot.netCents],
    ["taxCents", snapshot.taxCents],
  ] as const) {
    if (value !== null && value < 0)
      add(
        "negative_receipt_total",
        "blocking",
        field,
        "Receipt totals cannot be negative",
      );
  }
  const descriptions = new Map<string, number>();
  snapshot.lineItems.forEach((line, index) => {
    const path = `lineItems.${index}`;
    if (line.sourcePosition !== index)
      add(
        "invalid_line_order",
        "blocking",
        `${path}.sourcePosition`,
        "Line order is not contiguous",
      );
    const normalized = line.description.trim().toLocaleLowerCase("de-DE");
    if (!normalized)
      add(
        "empty_line_description",
        "blocking",
        `${path}.description`,
        "Line description is required",
      );
    else if (descriptions.has(normalized))
      add(
        "duplicate_line_description",
        "warning",
        `${path}.description`,
        "Line description is duplicated",
      );
    else descriptions.set(normalized, index);
    if (line.descriptionConfidence !== null && line.descriptionConfidence < 0.7)
      add(
        "low_confidence",
        "info",
        `${path}.description`,
        "Provider confidence is low",
      );
    if (line.categoryId === null && line.categorySuggestion)
      add(
        "category_suggestion",
        "info",
        `${path}.categoryId`,
        "An exact category rule matched",
      );
  });
  const lineSum = snapshot.lineItems.reduce(
    (sum, line) => sum + line.lineTotalCents,
    0,
  );
  if (!Number.isSafeInteger(lineSum))
    add(
      "unsafe_line_sum",
      "blocking",
      "lineItems",
      "Line total exceeds safe integer bounds",
    );
  else if (
    snapshot.lineItems.length > 0 &&
    Math.abs(lineSum - snapshot.totalCents) > 1
  )
    add(
      "line_sum_mismatch",
      "warning",
      "totalCents",
      "Line sum differs from receipt total",
    );
  if (
    snapshot.netCents !== null &&
    snapshot.taxCents !== null &&
    Math.abs(snapshot.netCents + snapshot.taxCents - snapshot.totalCents) > 1
  )
    add(
      "tax_total_mismatch",
      "warning",
      "taxCents",
      "Net plus tax differs from gross total",
    );
  if (snapshot.merchantConfidence !== null && snapshot.merchantConfidence < 0.7)
    add("low_confidence", "info", "merchantRaw", "Provider confidence is low");
  if (
    snapshot.purchaseDateConfidence !== null &&
    snapshot.purchaseDateConfidence < 0.7
  )
    add("low_confidence", "info", "purchaseDate", "Provider confidence is low");
  if (snapshot.totalConfidence !== null && snapshot.totalConfidence < 0.7)
    add("low_confidence", "info", "totalCents", "Provider confidence is low");
  return findings;
}

export function proposalDifferences(
  original: ProposalSnapshot,
  accepted: ProposalSnapshot,
) {
  const differences: { path: string; proposed: unknown; accepted: unknown }[] =
    [];
  const compare = (path: string, proposed: unknown, value: unknown) => {
    if (JSON.stringify(proposed) !== JSON.stringify(value))
      differences.push({ path, proposed, accepted: value });
  };
  for (const field of [
    "merchantRaw",
    "merchantBrandId",
    "merchantStoreId",
    "purchaseDate",
    "purchaseTime",
    "currency",
    "totalCents",
    "netCents",
    "taxCents",
  ] as const)
    compare(field, original[field], accepted[field]);
  compare("lineItems", original.lineItems, accepted.lineItems);
  return differences;
}

export type CorrectionComparison = {
  path: string;
  fieldKind: string;
  sourcePosition: number | null;
  correctionKind: "unchanged" | "changed" | "missing_filled" | "value_removed";
  proposed: unknown;
  accepted: unknown;
};

/** Compare only stable receipt fields and proposal line positions. This never
 * attempts to identify the same product across receipts. */
export function correctionComparisons(
  original: ProposalSnapshot,
  accepted: ProposalSnapshot,
): CorrectionComparison[] {
  const result: CorrectionComparison[] = [];
  const empty = (value: unknown) =>
    value === null || value === undefined || value === "";
  const add = (
    path: string,
    fieldKind: string,
    sourcePosition: number | null,
    proposed: unknown,
    value: unknown,
    proposedMissing = false,
  ) => {
    const same = JSON.stringify(proposed) === JSON.stringify(value);
    result.push({
      path,
      fieldKind,
      sourcePosition,
      correctionKind: same
        ? "unchanged"
        : (proposedMissing || empty(proposed)) && !empty(value)
          ? "missing_filled"
          : !empty(proposed) && empty(value)
            ? "value_removed"
            : "changed",
      proposed,
      accepted: value,
    });
  };
  for (const field of [
    "merchantRaw",
    "merchantBrandId",
    "merchantStoreId",
    "purchaseDate",
    "purchaseTime",
    "currency",
    "totalCents",
    "netCents",
    "taxCents",
  ] as const)
    add(
      field,
      field,
      null,
      original[field],
      accepted[field],
      field === "totalCents" && original.totalConfidence === null,
    );
  const count = Math.max(original.lineItems.length, accepted.lineItems.length);
  for (let position = 0; position < count; position++) {
    const before = original.lineItems[position];
    const after = accepted.lineItems[position];
    for (const field of [
      "description",
      "quantityMilli",
      "unitPriceCents",
      "lineTotalCents",
      "categoryId",
      "kind",
    ] as const)
      add(
        `lineItems.${position}.${field}`,
        `lineItem.${field}`,
        position,
        before?.[field] ?? null,
        after?.[field] ?? null,
        field === "lineTotalCents" &&
          (before?.lineTotalConfidence ?? null) === null,
      );
  }
  return result;
}
