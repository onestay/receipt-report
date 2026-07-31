import type { Prisma, PrismaClient } from "@prisma/client";
import {
  categorySuggestionRuleListSchema,
  categorySuggestionRuleSchema,
  categorySuggestionSchema,
  normalizeRuleDescription,
  type CategorySuggestion,
  type CategorySuggestionQuery,
  type CategorySuggestionRule,
  type CategorySuggestionRuleCreate,
  type CategorySuggestionRuleList,
  type CategorySuggestionRuleListQuery,
  type CategorySuggestionRuleUpdate,
  type CategorySuggestionScope,
} from "@receipt-report/contracts";
import {
  ConflictError,
  InvalidCursorError,
  InvalidReferenceError,
  NotFoundError,
  prismaErrorCode,
} from "./errors.js";

type Cursor = {
  normalizedDescription: string;
  scopeSpecificity: number;
  id: string;
};

const include = {
  brand: { select: { id: true, name: true } },
  store: { select: { id: true, brandId: true, name: true } },
  category: {
    include: {
      parent: { select: { archivedAt: true } },
      _count: { select: { children: true } },
    },
  },
} as const;
type Record = Prisma.CategorySuggestionRuleGetPayload<{
  include: typeof include;
}>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    ) as Partial<Cursor>;
    if (
      typeof decoded.normalizedDescription !== "string" ||
      typeof decoded.scopeSpecificity !== "number" ||
      !Number.isInteger(decoded.scopeSpecificity) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new Error("shape");
    }
    return decoded as Cursor;
  } catch {
    throw new InvalidCursorError("Invalid pagination cursor");
  }
}

function scopeData(
  scopeKind: CategorySuggestionScope,
  brandId?: string | null,
  storeId?: string | null,
) {
  if (scopeKind === "global") {
    return {
      scopeKind,
      scopeSpecificity: 0,
      scopeIdentity: "global",
      brandId: null,
      storeId: null,
    };
  }
  if (scopeKind === "brand") {
    if (!brandId) throw new InvalidReferenceError("brandId is required");
    return {
      scopeKind,
      scopeSpecificity: 1,
      scopeIdentity: brandId,
      brandId,
      storeId: null,
    };
  }
  if (!brandId || !storeId) {
    throw new InvalidReferenceError(
      "brandId and storeId are required for store scope",
    );
  }
  return {
    scopeKind,
    scopeSpecificity: 2,
    scopeIdentity: storeId,
    brandId,
    storeId,
  };
}

function validity(record: Record): {
  isValid: boolean;
  invalidReason: string | null;
} {
  if (record.category.archivedAt !== null)
    return { isValid: false, invalidReason: "Target category is archived" };
  if ((record.category.parent?.archivedAt ?? null) !== null)
    return {
      isValid: false,
      invalidReason: "Target category has an archived parent",
    };
  if (record.category._count.children > 0)
    return {
      isValid: false,
      invalidReason: "Target category is no longer a leaf",
    };
  return { isValid: true, invalidReason: null };
}

function output(record: Record): CategorySuggestionRule {
  const state = validity(record);
  return categorySuggestionRuleSchema.parse({
    ...record,
    category: {
      ...record.category,
      parentId: record.category.parentId,
      archivedAt: record.category.archivedAt?.toISOString() ?? null,
      isLeaf: record.category._count.children === 0,
      isEffectivelyActive:
        record.category.archivedAt === null &&
        (record.category.parent?.archivedAt ?? null) === null,
      isAssignable: state.isValid,
      createdAt: record.category.createdAt.toISOString(),
      updatedAt: record.category.updatedAt.toISOString(),
    },
    ...state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export class CategorySuggestionRuleRepository {
  public constructor(private readonly database: PrismaClient) {}

  private async validateReferences(
    input: CategorySuggestionRuleCreate | CategorySuggestionRuleUpdate,
  ): Promise<void> {
    const category = await this.database.category.findUnique({
      where: { id: input.categoryId },
      select: {
        archivedAt: true,
        parent: { select: { archivedAt: true } },
        _count: { select: { children: true } },
      },
    });
    if (
      !category ||
      category.archivedAt !== null ||
      (category.parent?.archivedAt ?? null) !== null ||
      category._count.children > 0
    ) {
      throw new InvalidReferenceError(
        "categoryId must reference an effectively active leaf category",
      );
    }
    if (input.scopeKind === "global") return;
    const brandId = input.brandId;
    if (!brandId) throw new InvalidReferenceError("brandId is required");
    const brand = await this.database.merchantBrand.findUnique({
      where: { id: brandId },
      select: { id: true },
    });
    if (!brand) throw new InvalidReferenceError("Unknown brandId");
    if (input.scopeKind === "store") {
      const storeId = input.storeId;
      if (!storeId) throw new InvalidReferenceError("storeId is required");
      const store = await this.database.merchantStore.findUnique({
        where: { id: storeId },
        select: { brandId: true },
      });
      if (!store) throw new InvalidReferenceError("Unknown storeId");
      if (store.brandId !== brandId) {
        throw new InvalidReferenceError("storeId does not belong to brandId");
      }
    }
  }

  async create(input: CategorySuggestionRuleCreate) {
    await this.validateReferences(input);
    try {
      return output(
        await this.database.categorySuggestionRule.create({
          data: {
            description: input.description,
            normalizedDescription: normalizeRuleDescription(input.description),
            categoryId: input.categoryId,
            ...scopeData(input.scopeKind, input.brandId, input.storeId),
          },
          include,
        }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === "P2002") {
        throw new ConflictError(
          "A rule already exists for this description and scope",
        );
      }
      throw error;
    }
  }

  async get(id: string): Promise<CategorySuggestionRule> {
    const record = await this.database.categorySuggestionRule.findUnique({
      where: { id },
      include,
    });
    if (!record) throw new NotFoundError("Category suggestion rule not found");
    return output(record);
  }

  async update(id: string, input: CategorySuggestionRuleUpdate) {
    await this.get(id);
    await this.validateReferences(input);
    try {
      return output(
        await this.database.categorySuggestionRule.update({
          where: { id },
          data: {
            description: input.description,
            normalizedDescription: normalizeRuleDescription(input.description),
            categoryId: input.categoryId,
            ...scopeData(input.scopeKind, input.brandId, input.storeId),
          },
          include,
        }),
      );
    } catch (error) {
      if (prismaErrorCode(error) === "P2002") {
        throw new ConflictError(
          "A rule already exists for this description and scope",
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.database.categorySuggestionRule.delete({ where: { id } });
  }

  async list(
    query: CategorySuggestionRuleListQuery,
  ): Promise<CategorySuggestionRuleList> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const normalizedQuery = query.query
      ? normalizeRuleDescription(query.query)
      : "";
    const exactDescription = query.exactDescription
      ? normalizeRuleDescription(query.exactDescription)
      : undefined;
    const where: Prisma.CategorySuggestionRuleWhereInput = {
      ...(exactDescription ? { normalizedDescription: exactDescription } : {}),
      ...(normalizedQuery
        ? { normalizedDescription: { contains: normalizedQuery } }
        : {}),
      ...(query.scopeKind ? { scopeKind: query.scopeKind } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(cursor
        ? {
            OR: [
              {
                normalizedDescription: {
                  gt: cursor.normalizedDescription,
                },
              },
              {
                normalizedDescription: cursor.normalizedDescription,
                scopeSpecificity: { gt: cursor.scopeSpecificity },
              },
              {
                normalizedDescription: cursor.normalizedDescription,
                scopeSpecificity: cursor.scopeSpecificity,
                id: { gt: cursor.id },
              },
            ],
          }
        : {}),
    };
    // Validity is derived from live hierarchy state. A validity-filtered query
    // must inspect the complete ordered remainder so invalid rows cannot make a
    // later matching page unreachable.
    const records = await this.database.categorySuggestionRule.findMany({
      where,
      include,
      orderBy: [
        { normalizedDescription: "asc" },
        { scopeSpecificity: "asc" },
        { id: "asc" },
      ],
      ...(query.validity ? {} : { take: query.limit + 1 }),
    });
    const filtered = query.validity
      ? records.filter((record) =>
          query.validity === "valid"
            ? validity(record).isValid
            : !validity(record).isValid,
        )
      : records;
    const page = filtered.slice(0, query.limit);
    const last = page.at(-1);
    return categorySuggestionRuleListSchema.parse({
      rules: page.map(output),
      nextCursor:
        filtered.length > query.limit && last
          ? encodeCursor({
              normalizedDescription: last.normalizedDescription,
              scopeSpecificity: last.scopeSpecificity,
              id: last.id,
            })
          : null,
    });
  }

  async suggest(query: CategorySuggestionQuery): Promise<CategorySuggestion> {
    if (query.storeId) {
      const store = await this.database.merchantStore.findUnique({
        where: { id: query.storeId },
        select: { brandId: true },
      });
      if (!store) throw new InvalidReferenceError("Unknown storeId");
      if (store.brandId !== query.brandId) {
        throw new InvalidReferenceError("storeId does not belong to brandId");
      }
    } else if (query.brandId) {
      const brand = await this.database.merchantBrand.findUnique({
        where: { id: query.brandId },
        select: { id: true },
      });
      if (!brand) throw new InvalidReferenceError("Unknown brandId");
    }
    const normalizedDescription = normalizeRuleDescription(query.description);
    const eligible: Prisma.CategorySuggestionRuleWhereInput[] = [
      { scopeKind: "global", scopeIdentity: "global" },
    ];
    if (query.brandId) {
      eligible.unshift({
        scopeKind: "brand",
        scopeIdentity: query.brandId,
      });
    }
    if (query.storeId) {
      eligible.unshift({
        scopeKind: "store",
        scopeIdentity: query.storeId,
      });
    }
    const records = await this.database.categorySuggestionRule.findMany({
      where: { normalizedDescription, OR: eligible },
      include,
      orderBy: [{ scopeSpecificity: "desc" }, { id: "asc" }],
    });
    const match = records.find((record) => validity(record).isValid);
    return categorySuggestionSchema.parse({
      suggestion: match ? output(match) : null,
    });
  }
}
