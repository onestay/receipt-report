import type { Prisma, PrismaClient } from "@prisma/client";
import {
  merchantBrandListSchema,
  merchantBrandSchema,
  merchantStoreListSchema,
  merchantStoreSchema,
  normalizeMerchantAddressKey,
  normalizeMerchantName,
  type MerchantBrand,
  type MerchantBrandCreate,
  type MerchantBrandList,
  type MerchantBrandUpdate,
  type MerchantListQuery,
  type MerchantStore,
  type MerchantStoreCreate,
  type MerchantStoreList,
  type MerchantStoreListQuery,
  type MerchantStoreUpdate,
} from "@receipt-report/contracts";
import {
  ConflictError,
  InvalidCursorError,
  NotFoundError,
  prismaErrorCode,
} from "./errors.js";

type MerchantCursor = { normalizedName: string; id: string };

const uniqueConstraintViolation = "P2002";
const foreignKeyConstraintViolation = "P2003";
/** Prisma reports a restricted delete as "record required but not found". */
const restrictedDelete = "P2014";

function encodeCursor(cursor: MerchantCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): MerchantCursor {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("normalizedName" in decoded) ||
      !("id" in decoded) ||
      typeof decoded.normalizedName !== "string" ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new Error("shape");
    }
    return { normalizedName: decoded.normalizedName, id: decoded.id };
  } catch {
    throw new InvalidCursorError("Invalid pagination cursor");
  }
}

/** Keyset pagination over the ascending (normalized name, id) ordering. */
function afterCursor(cursor: MerchantCursor) {
  return {
    OR: [
      { normalizedName: { gt: cursor.normalizedName } },
      { normalizedName: cursor.normalizedName, id: { gt: cursor.id } },
    ],
  };
}

function searchFilter(query: string | undefined) {
  const normalized = query ? normalizeMerchantName(query) : "";
  return normalized.length === 0
    ? undefined
    : { normalizedName: { contains: normalized } };
}

function isUniqueViolation(error: unknown): boolean {
  return prismaErrorCode(error) === uniqueConstraintViolation;
}

function isRestrictedDelete(error: unknown): boolean {
  const code = prismaErrorCode(error);
  return code === foreignKeyConstraintViolation || code === restrictedDelete;
}

function brand(record: {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
}): MerchantBrand {
  return merchantBrandSchema.parse({
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function store(record: {
  id: string;
  brandId: string;
  name: string;
  normalizedName: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  normalizedAddressKey: string;
  createdAt: Date;
  updatedAt: Date;
}): MerchantStore {
  return merchantStoreSchema.parse({
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function storeAddressData(input: {
  street?: string | null | undefined;
  postalCode?: string | null | undefined;
  city?: string | null | undefined;
}) {
  return {
    street: input.street ?? null,
    postalCode: input.postalCode ?? null,
    city: input.city ?? null,
    normalizedAddressKey: normalizeMerchantAddressKey(input),
  };
}

export class MerchantRepository {
  public constructor(private readonly database: PrismaClient) {}

  async createBrand(input: MerchantBrandCreate): Promise<MerchantBrand> {
    try {
      return brand(
        await this.database.merchantBrand.create({
          data: {
            name: input.name,
            normalizedName: normalizeMerchantName(input.name),
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Merchant brand name already exists");
      }
      throw error;
    }
  }

  async getBrand(id: string): Promise<MerchantBrand> {
    const record = await this.database.merchantBrand.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundError("Merchant brand not found");
    return brand(record);
  }

  async listBrands(query: MerchantListQuery): Promise<MerchantBrandList> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const where: Prisma.MerchantBrandWhereInput = {
      ...searchFilter(query.query),
      ...(cursor ? afterCursor(cursor) : {}),
    };
    const records = await this.database.merchantBrand.findMany({
      where,
      orderBy: [{ normalizedName: "asc" }, { id: "asc" }],
      take: query.limit + 1,
    });
    const hasMore = records.length > query.limit;
    const page = records.slice(0, query.limit);
    const last = page.at(-1);
    return merchantBrandListSchema.parse({
      brands: page.map(brand),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              normalizedName: last.normalizedName,
              id: last.id,
            })
          : null,
    });
  }

  async updateBrand(
    id: string,
    input: MerchantBrandUpdate,
  ): Promise<MerchantBrand> {
    await this.getBrand(id);
    try {
      return brand(
        await this.database.merchantBrand.update({
          where: { id },
          data: {
            name: input.name,
            normalizedName: normalizeMerchantName(input.name),
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Merchant brand name already exists");
      }
      throw error;
    }
  }

  /** Restrictive: a brand with stores or linked receipts cannot be deleted. */
  async deleteBrand(id: string): Promise<void> {
    await this.getBrand(id);
    const [stores, receipts] = await Promise.all([
      this.database.merchantStore.count({ where: { brandId: id } }),
      this.database.receipt.count({ where: { merchantBrandId: id } }),
    ]);
    if (stores > 0 || receipts > 0) {
      throw new ConflictError(
        "Merchant brand still has stores or linked receipts",
      );
    }
    try {
      await this.database.merchantBrand.delete({ where: { id } });
    } catch (error) {
      if (isRestrictedDelete(error)) {
        throw new ConflictError(
          "Merchant brand still has stores or linked receipts",
        );
      }
      throw error;
    }
  }

  async createStore(input: MerchantStoreCreate): Promise<MerchantStore> {
    await this.getBrand(input.brandId);
    try {
      return store(
        await this.database.merchantStore.create({
          data: {
            brandId: input.brandId,
            name: input.name,
            normalizedName: normalizeMerchantName(input.name),
            ...storeAddressData(input),
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "Merchant store name and address already exist for this brand",
        );
      }
      throw error;
    }
  }

  async getStore(id: string): Promise<MerchantStore> {
    const record = await this.database.merchantStore.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundError("Merchant store not found");
    return store(record);
  }

  async listStores(query: MerchantStoreListQuery): Promise<MerchantStoreList> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const where: Prisma.MerchantStoreWhereInput = {
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...searchFilter(query.query),
      ...(cursor ? afterCursor(cursor) : {}),
    };
    const records = await this.database.merchantStore.findMany({
      where,
      orderBy: [{ normalizedName: "asc" }, { id: "asc" }],
      take: query.limit + 1,
    });
    const hasMore = records.length > query.limit;
    const page = records.slice(0, query.limit);
    const last = page.at(-1);
    return merchantStoreListSchema.parse({
      stores: page.map(store),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              normalizedName: last.normalizedName,
              id: last.id,
            })
          : null,
    });
  }

  async updateStore(
    id: string,
    input: MerchantStoreUpdate,
  ): Promise<MerchantStore> {
    await this.getStore(id);
    try {
      return store(
        await this.database.merchantStore.update({
          where: { id },
          data: {
            name: input.name,
            normalizedName: normalizeMerchantName(input.name),
            ...storeAddressData(input),
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "Merchant store name and address already exist for this brand",
        );
      }
      throw error;
    }
  }

  /** Restrictive: a store linked from a receipt cannot be deleted. */
  async deleteStore(id: string): Promise<void> {
    await this.getStore(id);
    const receipts = await this.database.receipt.count({
      where: { merchantStoreId: id },
    });
    if (receipts > 0) {
      throw new ConflictError("Merchant store still has linked receipts");
    }
    try {
      await this.database.merchantStore.delete({ where: { id } });
    } catch (error) {
      if (isRestrictedDelete(error)) {
        throw new ConflictError("Merchant store still has linked receipts");
      }
      throw error;
    }
  }
}
