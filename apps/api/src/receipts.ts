import type { Prisma, PrismaClient } from "@prisma/client";
import {
  receiptDetailSchema,
  receiptListSchema,
  receiptSummarySchema,
  type ReceiptCreate,
  type ReceiptDetail,
  type ReceiptList,
  type ReceiptUpdate,
} from "@receipt-report/contracts";

type Cursor = { purchaseDate: string; id: string };

export class InvalidCursorError extends Error {}
export class ReceiptNotFoundError extends Error {}

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

const receiptInclude = {
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
      position: item.position,
    })),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function itemData(item: ReceiptCreate["lineItems"][number], position: number) {
  return {
    description: item.description,
    quantityMilli: item.quantityMilli ?? null,
    unitPriceCents: item.unitPriceCents ?? null,
    lineTotalCents: item.lineTotalCents,
    position,
  };
}

export class ReceiptRepository {
  public constructor(private readonly database: PrismaClient) {}

  async create(input: ReceiptCreate): Promise<ReceiptDetail> {
    const record = await this.database.receipt.create({
      data: {
        merchant: input.merchant,
        purchaseDate: input.purchaseDate,
        purchaseTime: input.purchaseTime ?? null,
        currency: input.currency,
        notes: input.notes || null,
        totalCents: input.totalCents,
        lineItems: {
          create: input.lineItems.map(itemData),
        },
      },
      include: receiptInclude,
    });
    return detail(record);
  }

  async get(id: string): Promise<ReceiptDetail> {
    const record = await this.database.receipt.findUnique({
      where: { id },
      include: receiptInclude,
    });
    if (!record) throw new ReceiptNotFoundError("Receipt not found");
    return detail(record);
  }

  async list(limit: number, cursorValue?: string): Promise<ReceiptList> {
    const cursor = cursorValue ? decodeCursor(cursorValue) : undefined;
    const records = await this.database.receipt.findMany({
      ...(cursor
        ? {
            where: {
              OR: [
                { purchaseDate: { lt: cursor.purchaseDate } },
                { purchaseDate: cursor.purchaseDate, id: { lt: cursor.id } },
              ],
            },
          }
        : {}),
      orderBy: [{ purchaseDate: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: { _count: { select: { lineItems: true } } },
    });
    const hasMore = records.length > limit;
    const page = records.slice(0, limit);
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
    try {
      const record = await this.database.$transaction(async (transaction) => {
        const existing = await transaction.receipt.findUnique({
          where: { id },
        });
        if (!existing) throw new ReceiptNotFoundError("Receipt not found");
        if (input.lineItems) {
          await transaction.lineItem.deleteMany({ where: { receiptId: id } });
        }
        return transaction.receipt.update({
          where: { id },
          data: {
            ...(input.merchant === undefined
              ? {}
              : { merchant: input.merchant }),
            ...(input.purchaseDate === undefined
              ? {}
              : { purchaseDate: input.purchaseDate }),
            ...(input.purchaseTime === undefined
              ? {}
              : { purchaseTime: input.purchaseTime }),
            ...(input.currency === undefined
              ? {}
              : { currency: input.currency }),
            ...(input.notes === undefined
              ? {}
              : { notes: input.notes || null }),
            ...(input.totalCents === undefined
              ? {}
              : { totalCents: input.totalCents }),
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
    } catch (error) {
      if (error instanceof ReceiptNotFoundError) throw error;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    const result = await this.database.receipt.deleteMany({ where: { id } });
    if (result.count === 0) throw new ReceiptNotFoundError("Receipt not found");
  }
}
