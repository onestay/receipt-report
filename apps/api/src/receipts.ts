import type { Prisma, PrismaClient } from "@prisma/client";
import {
  receiptDetailSchema,
  receiptListSchema,
  receiptSummarySchema,
  type ReceiptCreate,
  type ReceiptDetail,
  type ReceiptList,
  type ReceiptListQuery,
  type ReceiptUpdate,
} from "@receipt-report/contracts";
import {
  ConflictError,
  InvalidCursorError,
  InvalidReferenceError,
  NotFoundError,
  prismaErrorCode,
} from "./errors.js";

type Cursor = { purchaseDate: string; id: string };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("purchaseDate" in decoded) ||
      !("id" in decoded) ||
      typeof decoded.purchaseDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(decoded.purchaseDate) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new Error("shape");
    }
    return { purchaseDate: decoded.purchaseDate, id: decoded.id };
  } catch {
    throw new InvalidCursorError("Invalid pagination cursor");
  }
}

const merchantInclude = {
  merchantBrand: { select: { id: true, name: true } },
  merchantStore: {
    select: {
      id: true,
      brandId: true,
      name: true,
      street: true,
      postalCode: true,
      city: true,
    },
  },
} as const;

const receiptInclude = {
  ...merchantInclude,
  lineItems: { orderBy: { position: "asc" as const } },
} as const;

type ReceiptWithItems = Prisma.ReceiptGetPayload<{
  include: typeof receiptInclude;
}>;

function detail(record: ReceiptWithItems): ReceiptDetail {
  return receiptDetailSchema.parse({
    ...record,
    lineItems: record.lineItems.map((item) => ({
      id: item.id,
      description: item.description,
      quantityMilli: item.quantityMilli,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
      kind: item.kind,
      categoryId: item.categoryId,
      position: item.position,
    })),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

type MerchantLinks = {
  merchantBrandId?: string | null | undefined;
  merchantStoreId?: string | null | undefined;
};

/**
 * Validates the canonical brand/store pair against persisted rows. The schemas
 * already guarantee a store is accompanied by a brand; this rejects unknown IDs
 * and a store that belongs to a different brand before anything is written.
 */
async function resolveMerchantLinks(
  database: Prisma.TransactionClient | PrismaClient,
  links: MerchantLinks,
): Promise<{ merchantBrandId: string | null; merchantStoreId: string | null }> {
  const merchantBrandId = links.merchantBrandId ?? null;
  const merchantStoreId = links.merchantStoreId ?? null;
  if (merchantStoreId !== null && merchantBrandId === null) {
    throw new InvalidReferenceError(
      "merchantBrandId is required when merchantStoreId is set",
    );
  }
  if (merchantBrandId !== null) {
    const existing = await database.merchantBrand.findUnique({
      where: { id: merchantBrandId },
      select: { id: true },
    });
    if (!existing) {
      throw new InvalidReferenceError("Unknown merchantBrandId");
    }
  }
  if (merchantStoreId !== null) {
    const existing = await database.merchantStore.findUnique({
      where: { id: merchantStoreId },
      select: { brandId: true },
    });
    if (!existing) {
      throw new InvalidReferenceError("Unknown merchantStoreId");
    }
    if (existing.brandId !== merchantBrandId) {
      throw new InvalidReferenceError(
        "merchantStoreId does not belong to merchantBrandId",
      );
    }
  }
  return { merchantBrandId, merchantStoreId };
}

type ReceiptItem = ReceiptCreate["lineItems"][number] & {
  id?: string | undefined;
};

function itemData(item: ReceiptItem, position: number) {
  return {
    ...(item.id === undefined ? {} : { id: item.id }),
    description: item.description,
    quantityMilli: item.quantityMilli ?? null,
    unitPriceCents: item.unitPriceCents ?? null,
    lineTotalCents: item.lineTotalCents,
    kind: item.kind,
    categoryId: item.categoryId ?? null,
    position,
  };
}

/**
 * Only effectively active leaves accept a new assignment. An existing line may
 * keep its exact historical assignment after that category is archived or
 * gains its first child.
 */
async function validateCategoryAssignments(
  database: Prisma.TransactionClient,
  items: ReceiptItem[],
  existingAssignments = new Map<string, string | null>(),
): Promise<void> {
  const seenItemIds = new Set<string>();
  for (const item of items) {
    if (item.id === undefined) continue;
    if (seenItemIds.has(item.id) || !existingAssignments.has(item.id)) {
      throw new InvalidReferenceError(
        "Line item id does not belong to this receipt",
      );
    }
    seenItemIds.add(item.id);
  }

  const categoryIds = [
    ...new Set(
      items
        .map((item) => item.categoryId)
        .filter((id): id is string => id !== null && id !== undefined),
    ),
  ];
  if (categoryIds.length === 0) return;
  const categories = await database.category.findMany({
    where: { id: { in: categoryIds } },
    select: {
      id: true,
      archivedAt: true,
      parent: { select: { archivedAt: true } },
      _count: { select: { children: true } },
    },
  });
  const byId = new Map(categories.map((record) => [record.id, record]));
  for (const item of items) {
    const categoryId = item.categoryId ?? null;
    if (categoryId === null) continue;
    const record = byId.get(categoryId);
    const preserved =
      item.id !== undefined && existingAssignments.get(item.id) === categoryId;
    if (
      !record ||
      (!preserved &&
        (record.archivedAt !== null ||
          (record.parent?.archivedAt ?? null) !== null ||
          record._count.children > 0))
    ) {
      throw new InvalidReferenceError(
        "categoryId must reference an effectively active leaf category",
      );
    }
  }
}

export class ReceiptRepository {
  public constructor(private readonly database: PrismaClient) {}

  async create(input: ReceiptCreate): Promise<ReceiptDetail> {
    const record = await this.database.$transaction(async (transaction) => {
      const links = await resolveMerchantLinks(transaction, input);
      await validateCategoryAssignments(transaction, input.lineItems);
      return transaction.receipt.create({
        data: {
          merchantRaw: input.merchantRaw,
          ...links,
          purchaseDate: input.purchaseDate,
          purchaseTime: input.purchaseTime ?? null,
          currency: input.currency,
          notes: input.notes || null,
          totalCents: input.totalCents,
          netCents: input.netCents ?? null,
          taxCents: input.taxCents ?? null,
          lineItems: {
            create: input.lineItems.map(itemData),
          },
        },
        include: receiptInclude,
      });
    });
    return detail(record);
  }

  async get(id: string): Promise<ReceiptDetail> {
    const record = await this.database.receipt.findUnique({
      where: { id },
      include: receiptInclude,
    });
    if (!record) throw new NotFoundError("Receipt not found");
    return detail(record);
  }

  async list(query: ReceiptListQuery): Promise<ReceiptList> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    let categoryIds = query.categoryId ? [query.categoryId] : undefined;
    if (query.categoryId && query.categorySubtree) {
      const children = await this.database.category.findMany({
        where: { parentId: query.categoryId },
        select: { id: true },
      });
      categoryIds = [query.categoryId, ...children.map((item) => item.id)];
    }
    const records = await this.database.receipt.findMany({
      where: {
        AND: [
          ...(cursor
            ? [
                {
                  OR: [
                    { purchaseDate: { lt: cursor.purchaseDate } },
                    {
                      purchaseDate: cursor.purchaseDate,
                      id: { lt: cursor.id },
                    },
                  ],
                },
              ]
            : []),
          ...(query.from ? [{ purchaseDate: { gte: query.from } }] : []),
          ...(query.to ? [{ purchaseDate: { lte: query.to } }] : []),
          ...(query.month
            ? [{ purchaseDate: { startsWith: query.month } }]
            : []),
          ...(query.merchantBrandId
            ? [{ merchantBrandId: query.merchantBrandId }]
            : []),
          ...(query.merchantStoreId
            ? [{ merchantStoreId: query.merchantStoreId }]
            : []),
          ...(query.merchantBrand ? [{ merchantBrandId: null }] : []),
          ...(query.merchantStore ? [{ merchantStoreId: null }] : []),
          ...(query.merchantQuery
            ? [{ merchantRaw: { contains: query.merchantQuery } }]
            : []),
          ...(categoryIds
            ? [{ lineItems: { some: { categoryId: { in: categoryIds } } } }]
            : []),
          ...(query.category === "uncategorized"
            ? [{ lineItems: { some: { categoryId: null } } }]
            : []),
        ],
      },
      orderBy: [{ purchaseDate: "desc" }, { id: "desc" }],
      include: {
        ...merchantInclude,
        lineItems: { select: { lineTotalCents: true } },
        extractionProposals: { select: { status: true } },
        _count: { select: { lineItems: true } },
      },
    });
    const matching =
      query.category === "unallocated-adjustment"
        ? records.filter(
            (record) =>
              record.lineItems.reduce(
                (sum, item) => sum + item.lineTotalCents,
                0,
              ) !== record.totalCents,
          )
        : records;
    const classified = query.provenance
      ? matching.filter((record) => {
          const approved = record.extractionProposals.filter(
            (item) => item.status === "approved",
          ).length;
          const value =
            approved === 0
              ? "manual"
              : approved === 1
                ? "ai_approved"
                : "ai_reprocessed";
          return value === query.provenance;
        })
      : matching;
    const hasMore = classified.length > query.limit;
    const page = classified.slice(0, query.limit);
    const last = page.at(-1);
    return receiptListSchema.parse({
      receipts: page.map((record) =>
        receiptSummarySchema.parse({
          ...record,
          createdAt: record.createdAt.toISOString(),
          updatedAt: record.updatedAt.toISOString(),
          lineItemCount: record._count.lineItems,
        }),
      ),
      nextCursor:
        hasMore && last
          ? encodeCursor({ purchaseDate: last.purchaseDate, id: last.id })
          : null,
    });
  }

  async update(id: string, input: ReceiptUpdate): Promise<ReceiptDetail> {
    const record = await this.database.$transaction(async (transaction) => {
      const existing = await transaction.receipt.findUnique({
        where: { id },
        include: {
          lineItems: { select: { id: true, categoryId: true } },
        },
      });
      if (!existing) throw new NotFoundError("Receipt not found");
      // Both link fields travel together or not at all, so canonical identity
      // is either fully restated or left untouched.
      const links =
        "merchantBrandId" in input
          ? await resolveMerchantLinks(transaction, input)
          : {};
      if (input.lineItems) {
        await validateCategoryAssignments(
          transaction,
          input.lineItems,
          new Map(existing.lineItems.map((item) => [item.id, item.categoryId])),
        );
        await transaction.lineItem.deleteMany({ where: { receiptId: id } });
      }
      return transaction.receipt.update({
        where: { id },
        data: {
          ...(input.merchantRaw === undefined
            ? {}
            : { merchantRaw: input.merchantRaw }),
          ...links,
          ...(input.purchaseDate === undefined
            ? {}
            : { purchaseDate: input.purchaseDate }),
          ...(input.purchaseTime === undefined
            ? {}
            : { purchaseTime: input.purchaseTime }),
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          ...(input.notes === undefined ? {} : { notes: input.notes || null }),
          ...(input.totalCents === undefined
            ? {}
            : { totalCents: input.totalCents }),
          ...(input.netCents === undefined ? {} : { netCents: input.netCents }),
          ...(input.taxCents === undefined ? {} : { taxCents: input.taxCents }),
          ...(input.lineItems === undefined
            ? {}
            : {
                lineItems: {
                  create: input.lineItems.map(itemData),
                },
              }),
        },
        include: receiptInclude,
      });
    });
    return detail(record);
  }

  async delete(id: string): Promise<void> {
    try {
      const result = await this.database.receipt.deleteMany({ where: { id } });
      if (result.count === 0) throw new NotFoundError("Receipt not found");
    } catch (error) {
      if (["P2003", "P2014"].includes(prismaErrorCode(error) ?? ""))
        throw new ConflictError(
          "Receipt with retained document or extraction history cannot be deleted",
        );
      throw error;
    }
  }
}
