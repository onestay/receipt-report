import type { Prisma, PrismaClient } from "@prisma/client";
import {
  categoryListSchema,
  categorySchema,
  normalizeCategoryName,
  type Category,
  type CategoryCreate,
  type CategoryList,
  type CategoryReorder,
  type CategoryUpdate,
} from "@receipt-report/contracts";
import {
  ConflictError,
  InvalidReferenceError,
  NotFoundError,
  prismaErrorCode,
} from "./errors.js";

type CategoryDatabase = Prisma.TransactionClient | PrismaClient;

const categoryWithState = {
  parent: { select: { archivedAt: true } },
  _count: { select: { children: true } },
} as const;

type CategoryRecord = Prisma.CategoryGetPayload<{
  include: typeof categoryWithState;
}>;

function siblingWhere(parentId: string | null): Prisma.CategoryWhereInput {
  return { parentId };
}

function category(record: CategoryRecord): Category {
  const isLeaf = record._count.children === 0;
  const isEffectivelyActive =
    record.archivedAt === null && (record.parent?.archivedAt ?? null) === null;
  return categorySchema.parse({
    id: record.id,
    name: record.name,
    normalizedName: record.normalizedName,
    parentId: record.parentId,
    position: record.position,
    archivedAt: record.archivedAt?.toISOString() ?? null,
    isLeaf,
    isEffectivelyActive,
    isAssignable: isLeaf && isEffectivelyActive,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

async function findCategory(
  database: CategoryDatabase,
  id: string,
): Promise<CategoryRecord> {
  const record = await database.category.findUnique({
    where: { id },
    include: categoryWithState,
  });
  if (!record) throw new NotFoundError("Category not found");
  return record;
}

async function resolveParent(
  database: CategoryDatabase,
  parentId: string,
): Promise<void> {
  const parent = await database.category.findUnique({
    where: { id: parentId },
    select: { parentId: true },
  });
  if (!parent) throw new InvalidReferenceError("Unknown category parentId");
  if (parent.parentId !== null) {
    throw new InvalidReferenceError(
      "Category parentId must reference a top-level category",
    );
  }
}

/**
 * Assigns a complete sibling order without transiently violating the unique
 * expression index on (coalesced parentId, position).
 */
async function writePositions(
  database: Prisma.TransactionClient,
  categoryIds: string[],
): Promise<void> {
  for (const [index, id] of categoryIds.entries()) {
    await database.category.update({
      where: { id },
      data: { position: -(index + 1) },
    });
  }
  for (const [position, id] of categoryIds.entries()) {
    await database.category.update({ where: { id }, data: { position } });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return prismaErrorCode(error) === "P2002";
}

async function withNameConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "Category name already exists among its siblings",
      );
    }
    throw error;
  }
}

export class CategoryRepository {
  public constructor(private readonly database: PrismaClient) {}

  async create(input: CategoryCreate): Promise<Category> {
    const parentId = input.parentId ?? null;
    return withNameConflict(() =>
      this.database.$transaction(async (transaction) => {
        if (parentId !== null) await resolveParent(transaction, parentId);
        const position = await transaction.category.count({
          where: siblingWhere(parentId),
        });
        return category(
          await transaction.category.create({
            data: {
              name: input.name,
              normalizedName: normalizeCategoryName(input.name),
              parentId,
              position,
            },
            include: categoryWithState,
          }),
        );
      }),
    );
  }

  async list(includeArchived: boolean): Promise<CategoryList> {
    const records = await this.database.category.findMany({
      include: categoryWithState,
      orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    const topLevel = records
      .filter((record) => record.parentId === null)
      .sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      );
    const children = new Map<string, CategoryRecord[]>();
    for (const record of records) {
      if (record.parentId === null) continue;
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record);
      children.set(record.parentId, siblings);
    }
    const ordered = topLevel.flatMap((parent) => [
      parent,
      ...(children.get(parent.id) ?? []).sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      ),
    ]);
    return categoryListSchema.parse({
      categories: ordered
        .map(category)
        .filter((record) => includeArchived || record.isEffectivelyActive),
    });
  }

  async update(id: string, input: CategoryUpdate): Promise<Category> {
    return withNameConflict(() =>
      this.database.$transaction(async (transaction) => {
        const existing = await findCategory(transaction, id);
        const destinationParentId =
          "parentId" in input ? (input.parentId ?? null) : existing.parentId;

        if (destinationParentId === id) {
          throw new InvalidReferenceError("A category cannot parent itself");
        }
        if (
          destinationParentId !== null &&
          destinationParentId !== existing.parentId
        ) {
          await resolveParent(transaction, destinationParentId);
        } else if ("parentId" in input && destinationParentId !== null) {
          await resolveParent(transaction, destinationParentId);
        }
        if (destinationParentId !== null && existing._count.children > 0) {
          throw new InvalidReferenceError(
            "A category with children cannot be moved below another category",
          );
        }

        const moved = destinationParentId !== existing.parentId;
        if (moved || input.position !== undefined) {
          const source = await transaction.category.findMany({
            where: siblingWhere(existing.parentId),
            orderBy: [{ position: "asc" }, { id: "asc" }],
            select: { id: true },
          });
          const destination = moved
            ? await transaction.category.findMany({
                where: siblingWhere(destinationParentId),
                orderBy: [{ position: "asc" }, { id: "asc" }],
                select: { id: true },
              })
            : source;
          const destinationIds = destination
            .map((record) => record.id)
            .filter((categoryId) => categoryId !== id);
          const targetPosition = input.position ?? destinationIds.length;
          if (targetPosition > destinationIds.length) {
            throw new InvalidReferenceError(
              "Category position exceeds the destination sibling count",
            );
          }

          if (moved) {
            await transaction.category.update({
              where: { id },
              data: { position: -1_000_000 },
            });
            await writePositions(
              transaction,
              source
                .map((record) => record.id)
                .filter((categoryId) => categoryId !== id),
            );
            await transaction.category.update({
              where: { id },
              data: { parentId: destinationParentId },
            });
          }
          destinationIds.splice(targetPosition, 0, id);
          await writePositions(transaction, destinationIds);
        }

        await transaction.category.update({
          where: { id },
          data: {
            ...(input.name === undefined
              ? {}
              : {
                  name: input.name,
                  normalizedName: normalizeCategoryName(input.name),
                }),
          },
        });
        return category(await findCategory(transaction, id));
      }),
    );
  }

  async reorder(input: CategoryReorder): Promise<CategoryList> {
    await this.database.$transaction(async (transaction) => {
      if (input.parentId !== null) {
        await resolveParent(transaction, input.parentId);
      }
      const siblings = await transaction.category.findMany({
        where: siblingWhere(input.parentId),
        select: { id: true },
      });
      const actualIds = new Set(siblings.map((record) => record.id));
      if (
        actualIds.size !== input.categoryIds.length ||
        input.categoryIds.some((id) => !actualIds.has(id))
      ) {
        throw new InvalidReferenceError(
          "categoryIds must contain every sibling exactly once",
        );
      }
      await writePositions(transaction, input.categoryIds);
    });
    return this.list(true);
  }

  async archive(id: string): Promise<Category> {
    await findCategory(this.database, id);
    await this.database.category.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    return category(await findCategory(this.database, id));
  }

  async restore(id: string): Promise<Category> {
    const existing = await findCategory(this.database, id);
    if (existing.parent?.archivedAt) {
      throw new InvalidReferenceError(
        "A child category cannot be restored while its parent is archived",
      );
    }
    await this.database.category.update({
      where: { id },
      data: { archivedAt: null },
    });
    return category(await findCategory(this.database, id));
  }

  async delete(id: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const existing = await findCategory(transaction, id);
      const assignments = await transaction.lineItem.count({
        where: { categoryId: id },
      });
      const suggestionRules = await transaction.categorySuggestionRule.count({
        where: { categoryId: id },
      });
      if (
        existing._count.children > 0 ||
        assignments > 0 ||
        suggestionRules > 0
      ) {
        throw new ConflictError(
          suggestionRules > 0
            ? "Category still has suggestion rules"
            : "Category still has children or line-item assignments",
        );
      }
      await transaction.category.delete({ where: { id } });
      const remaining = await transaction.category.findMany({
        where: siblingWhere(existing.parentId),
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      await writePositions(
        transaction,
        remaining.map((record) => record.id),
      );
    });
  }
}
