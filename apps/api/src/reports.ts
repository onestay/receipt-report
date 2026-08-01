import {
  spendingReportSchema,
  spendingWorkflowSummarySchema,
  type SpendingReportQuery,
} from "@receipt-report/contracts";
import type { Database } from "@receipt-report/database";

type Provenance = "manual" | "ai_approved" | "ai_reprocessed";
type Bucket = {
  key: string;
  label: string;
  grossCents: number;
  receipts: Set<string>;
  parameters: Record<string, string>;
};

function provenance(receipt: {
  extractionProposals: { status: string }[];
}): Provenance {
  const approved = receipt.extractionProposals.filter(
    (item) => item.status === "approved",
  ).length;
  return approved === 0
    ? "manual"
    : approved === 1
      ? "ai_approved"
      : "ai_reprocessed";
}

function link(base: SpendingReportQuery, extra: Record<string, string>) {
  const values: Record<string, string> = {
    from: base.from,
    to: base.to,
    ...extra,
  };
  if (base.categoryId) values.categoryId = base.categoryId;
  if (base.categorySubtree) values.categorySubtree = "true";
  if (base.merchantBrandId) values.merchantBrandId = base.merchantBrandId;
  if (base.merchantStoreId) values.merchantStoreId = base.merchantStoreId;
  if (base.merchantQuery) values.merchantQuery = base.merchantQuery;
  if (base.provenance) values.provenance = base.provenance;
  return `/api/v1/receipts?${new URLSearchParams(values)}`;
}

export class ReportRepository {
  constructor(private readonly database: Database) {}

  async spending(query: SpendingReportQuery) {
    let categoryIds: string[] | undefined;
    if (query.categoryId) {
      categoryIds = [query.categoryId];
      if (query.categorySubtree) {
        const children = await this.database.category.findMany({
          where: { parentId: query.categoryId },
          select: { id: true },
        });
        categoryIds.push(...children.map((item) => item.id));
      }
    }
    const receipts = await this.database.receipt.findMany({
      where: {
        purchaseDate: { gte: query.from, lte: query.to },
        ...(query.merchantBrandId
          ? { merchantBrandId: query.merchantBrandId }
          : {}),
        ...(query.merchantStoreId
          ? { merchantStoreId: query.merchantStoreId }
          : {}),
        ...(query.merchantQuery
          ? { merchantRaw: { contains: query.merchantQuery } }
          : {}),
        ...(categoryIds
          ? { lineItems: { some: { categoryId: { in: categoryIds } } } }
          : {}),
      },
      orderBy: [{ purchaseDate: "asc" }, { id: "asc" }],
      include: {
        merchantBrand: { select: { id: true, name: true } },
        merchantStore: { select: { id: true, name: true } },
        lineItems: {
          include: {
            category: { include: { _count: { select: { children: true } } } },
          },
        },
        extractionProposals: { select: { status: true } },
      },
    });
    const selected = query.provenance
      ? receipts.filter((item) => provenance(item) === query.provenance)
      : receipts;
    const scopedGross = new Map(
      selected.map((receipt) => [
        receipt.id,
        categoryIds
          ? receipt.lineItems
              .filter(
                (line) =>
                  line.categoryId !== null &&
                  categoryIds.includes(line.categoryId),
              )
              .reduce((sum, line) => sum + line.lineTotalCents, 0)
          : receipt.totalCents,
      ]),
    );
    const grossCents = selected.reduce(
      (sum, item) => sum + (scopedGross.get(item.id) ?? 0),
      0,
    );
    const net = categoryIds
      ? []
      : selected.filter((item) => item.netCents !== null);
    const tax = categoryIds
      ? []
      : selected.filter((item) => item.taxCents !== null);
    const buckets = (kind: "month" | "brand" | "store" | "raw") => {
      const map = new Map<string, Bucket>();
      for (const receipt of selected) {
        const value =
          kind === "month"
            ? {
                key: receipt.purchaseDate.slice(0, 7),
                label: receipt.purchaseDate.slice(0, 7),
                parameters: { month: receipt.purchaseDate.slice(0, 7) },
              }
            : kind === "brand"
              ? {
                  key: receipt.merchantBrand?.id ?? "unassigned",
                  label: receipt.merchantBrand?.name ?? "Unassigned brand",
                  parameters: receipt.merchantBrand
                    ? { merchantBrandId: receipt.merchantBrand.id }
                    : { merchantBrand: "unassigned" },
                }
              : kind === "store"
                ? {
                    key: receipt.merchantStore?.id ?? "unassigned",
                    label: receipt.merchantStore?.name ?? "Unassigned store",
                    parameters: receipt.merchantStore
                      ? { merchantStoreId: receipt.merchantStore.id }
                      : { merchantStore: "unassigned" },
                  }
                : {
                    key: receipt.merchantRaw,
                    label: receipt.merchantRaw,
                    parameters: { merchantQuery: receipt.merchantRaw },
                  };
        const bucket = map.get(value.key) ?? {
          ...value,
          grossCents: 0,
          receipts: new Set<string>(),
        };
        bucket.grossCents += scopedGross.get(receipt.id) ?? 0;
        bucket.receipts.add(receipt.id);
        map.set(value.key, bucket);
      }
      return [...map.values()]
        .sort(
          (a, b) =>
            b.grossCents - a.grossCents ||
            a.label.localeCompare(b.label) ||
            a.key.localeCompare(b.key),
        )
        .map((item) => ({
          key: item.key,
          label: item.label,
          grossCents: item.grossCents,
          receiptCount: item.receipts.size,
          drillDownUrl: link(query, item.parameters),
        }));
    };
    const categoryMap = new Map<string, Bucket>();
    for (const receipt of selected) {
      let allocated = 0;
      for (const line of receipt.lineItems) {
        if (
          categoryIds &&
          (line.categoryId === null || !categoryIds.includes(line.categoryId))
        )
          continue;
        allocated += line.lineTotalCents;
        const key = line.categoryId ?? "uncategorized";
        const label = line.category
          ? `${line.category.name}${line.category._count.children > 0 ? " (direct historical assignment)" : ""}`
          : "Uncategorized";
        const parameters = line.categoryId
          ? { categoryId: line.categoryId }
          : { category: "uncategorized" };
        const bucket = categoryMap.get(key) ?? {
          key,
          label,
          grossCents: 0,
          receipts: new Set<string>(),
          parameters,
        };
        bucket.grossCents += line.lineTotalCents;
        bucket.receipts.add(receipt.id);
        categoryMap.set(key, bucket);
      }
      const adjustment = categoryIds ? 0 : receipt.totalCents - allocated;
      if (adjustment !== 0) {
        const key = "unallocated-adjustment";
        const bucket = categoryMap.get(key) ?? {
          key,
          label: "Unallocated receipt adjustment",
          grossCents: 0,
          receipts: new Set<string>(),
          parameters: { category: key },
        };
        bucket.grossCents += adjustment;
        bucket.receipts.add(receipt.id);
        categoryMap.set(key, bucket);
      }
    }
    const categories = [...categoryMap.values()]
      .sort(
        (a, b) =>
          b.grossCents - a.grossCents ||
          a.label.localeCompare(b.label) ||
          a.key.localeCompare(b.key),
      )
      .map((item) => ({
        key: item.key,
        label: item.label,
        grossCents: item.grossCents,
        receiptCount: item.receipts.size,
        drillDownUrl: link(query, item.parameters),
      }));
    return spendingReportSchema.parse({
      timezone: "Europe/Berlin",
      range: { from: query.from, to: query.to },
      filters: Object.fromEntries(
        Object.entries(query).filter(([key]) => key !== "from" && key !== "to"),
      ),
      totals: {
        grossCents,
        receiptCount: selected.length,
        averageReceiptCents: selected.length
          ? Math.round(grossCents / selected.length)
          : null,
        netCents: net.length
          ? net.reduce((sum, item) => sum + (item.netCents ?? 0), 0)
          : null,
        taxCents: tax.length
          ? tax.reduce((sum, item) => sum + (item.taxCents ?? 0), 0)
          : null,
        coverage: {
          receipts: selected.length,
          net: net.length,
          tax: tax.length,
        },
      },
      monthly: buckets("month"),
      categories,
      merchantBrands: buckets("brand"),
      merchantStores: buckets("store"),
      rawMerchants: buckets("raw"),
    });
  }

  async workflow() {
    const receipts = await this.database.receipt.findMany({
      include: {
        document: {
          include: {
            extractionJobs: { orderBy: { createdAt: "desc" }, take: 1 },
            extractionProposals: { where: { status: "pending" }, take: 1 },
          },
        },
      },
    });
    const result = {
      preparing: 0,
      queued: 0,
      processing: 0,
      needsReview: 0,
      failed: 0,
    };
    for (const receipt of receipts) {
      const document = receipt.document;
      if (!document) continue;
      if (document.normalizationStatus === "failed") result.failed++;
      else if (
        document.normalizationStatus === "pending" ||
        document.normalizationStatus === "running"
      )
        result.preparing++;
      else {
        const job = document.extractionJobs[0];
        if (!job) continue;
        if (job.status === "pending" || job.status === "retry_wait")
          result.queued++;
        else if (job.status === "running") result.processing++;
        else if (job.status === "failed") result.failed++;
        else if (document.extractionProposals.length) result.needsReview++;
      }
    }
    return spendingWorkflowSummarySchema.parse(result);
  }
}
