import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@receipt-report/database";
import type { Express } from "express";
import { createApp } from "./app.js";

let database: Database | undefined;
let directory: string | undefined;
let app: Express;

beforeEach(async () => {
  directory = await mkdtemp(
    join(tmpdir(), `receipt-report-categories-${process.pid}-`),
  );
  const databaseUrl = `file:${join(directory, "categories.db")}`;
  execFileSync(
    "pnpm",
    ["--filter", "@receipt-report/database", "db:migrate:deploy"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
  database = await createDatabase(databaseUrl);
  app = createApp({ database });
});

afterEach(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  database = undefined;
  directory = undefined;
});

function createCategory(
  name: string,
  parentId: string | null = null,
): request.Test {
  return request(app).post("/api/v1/categories").send({ name, parentId });
}

type CategoryBody = {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  archivedAt: string | null;
  isLeaf: boolean;
  isEffectivelyActive: boolean;
  isAssignable: boolean;
};

async function categories(includeArchived = true): Promise<CategoryBody[]> {
  const response = await request(app)
    .get(`/api/v1/categories${includeArchived ? "?includeArchived=true" : ""}`)
    .expect(200);
  return response.body.categories as CategoryBody[];
}

function createReceipt(lineItems: Record<string, unknown>[]): request.Test {
  return request(app).post("/api/v1/receipts").send({
    merchantRaw: "Synthetic category test",
    purchaseDate: "2026-07-30",
    totalCents: 100,
    lineItems,
  });
}

describe("category taxonomy", () => {
  it("lists the exact migration-seeded taxonomy in hierarchy order", async () => {
    const listed = await categories(false);
    expect(listed).toHaveLength(24);
    expect(listed.map((record) => record.name)).toEqual([
      "Food",
      "Fruit & vegetables",
      "Meat & fish",
      "Dairy & eggs",
      "Bakery",
      "Pantry & cooking",
      "Snacks & sweets",
      "Drinks",
      "Alcohol",
      "Household",
      "Cleaning",
      "Paper goods",
      "Home & kitchen supplies",
      "Personal care",
      "Hygiene",
      "Cosmetics",
      "Hair care",
      "Eating out",
      "Health",
      "Pets",
      "Baby",
      "Clothing",
      "Electronics",
      "Other",
    ]);
    expect(listed[0]).toMatchObject({
      parentId: null,
      position: 0,
      isLeaf: false,
      isEffectivelyActive: true,
      isAssignable: false,
    });
    expect(listed[1]).toMatchObject({
      parentId: listed[0]?.id,
      position: 0,
      isLeaf: true,
      isAssignable: true,
    });
    expect(listed.at(-1)).toMatchObject({
      name: "Other",
      position: 9,
      isAssignable: true,
    });
  });

  it("creates, renames, normalizes, and reserves archived sibling names", async () => {
    const created = await createCategory("  Fresh Produce ");
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Fresh Produce",
      normalizedName: "fresh produce",
      parentId: null,
      position: 10,
      archivedAt: null,
      isAssignable: true,
    });
    await request(app)
      .patch(`/api/v1/categories/${created.body.id as string}`)
      .send({ name: "Fresh Produce" })
      .expect(200)
      .expect((response) =>
        expect(response.body.normalizedName).toBe("fresh produce"),
      );
    await request(app)
      .post(`/api/v1/categories/${created.body.id as string}/archive`)
      .expect(200)
      .expect((response) => {
        expect(response.body.archivedAt).toEqual(expect.any(String));
        expect(response.body.isEffectivelyActive).toBe(false);
      });
    expect(
      (await categories(false)).some(({ id }) => id === created.body.id),
    ).toBe(false);
    expect(
      (await categories(true)).some(({ id }) => id === created.body.id),
    ).toBe(true);
    await createCategory(" fresh\tproduce ").expect(409, {
      error: {
        code: "conflict",
        message: "Category name already exists among its siblings",
      },
    });

    const parent = await createCategory("Second parent");
    expect(parent.status).toBe(201);
    await createCategory("Fresh Produce", parent.body.id as string).expect(201);
    await request(app)
      .post(`/api/v1/categories/${created.body.id as string}/restore`)
      .expect(200)
      .expect((response) => expect(response.body.archivedAt).toBeNull());
  });

  it("rejects cycles, grandchildren, invalid demotion, and invalid positions", async () => {
    const parent = await createCategory("Hierarchy A");
    const other = await createCategory("Hierarchy B");
    expect(parent.status).toBe(201);
    expect(other.status).toBe(201);
    const child = await createCategory(
      "Hierarchy child",
      parent.body.id as string,
    );
    expect(child.status).toBe(201);

    await createCategory("Grandchild", child.body.id as string).expect(400, {
      error: {
        code: "validation_error",
        message: "Category parentId must reference a top-level category",
      },
    });
    await request(app)
      .patch(`/api/v1/categories/${parent.body.id as string}`)
      .send({ parentId: other.body.id })
      .expect(400, {
        error: {
          code: "validation_error",
          message:
            "A category with children cannot be moved below another category",
        },
      });
    await request(app)
      .patch(`/api/v1/categories/${child.body.id as string}`)
      .send({ parentId: child.body.id })
      .expect(400, {
        error: {
          code: "validation_error",
          message: "A category cannot parent itself",
        },
      });
    await request(app)
      .patch(`/api/v1/categories/${child.body.id as string}`)
      .send({ parentId: other.body.id, position: 2 })
      .expect(400, {
        error: {
          code: "validation_error",
          message: "Category position exceeds the destination sibling count",
        },
      });
    await request(app)
      .patch(`/api/v1/categories/${child.body.id as string}`)
      .send({ parentId: "clx0000000000000000000000" })
      .expect(400, {
        error: {
          code: "validation_error",
          message: "Unknown category parentId",
        },
      });
  });

  it("moves, promotes, demotes, and reorders with contiguous positions", async () => {
    const firstParent = await createCategory("Ordering A");
    const secondParent = await createCategory("Ordering B");
    const first = await createCategory(
      "First child",
      firstParent.body.id as string,
    );
    const second = await createCategory(
      "Second child",
      firstParent.body.id as string,
    );
    const third = await createCategory(
      "Third child",
      firstParent.body.id as string,
    );
    for (const response of [firstParent, secondParent, first, second, third])
      expect(response.status).toBe(201);

    await request(app)
      .put("/api/v1/categories/reorder")
      .send({
        parentId: firstParent.body.id,
        categoryIds: [third.body.id, first.body.id, second.body.id],
      })
      .expect(200);
    let listed = await categories();
    expect(
      listed
        .filter(({ parentId }) => parentId === firstParent.body.id)
        .map(({ name, position }) => [name, position]),
    ).toEqual([
      ["Third child", 0],
      ["First child", 1],
      ["Second child", 2],
    ]);

    await request(app)
      .patch(`/api/v1/categories/${first.body.id as string}`)
      .send({ parentId: secondParent.body.id, position: 0 })
      .expect(200);
    listed = await categories();
    expect(
      listed
        .filter(({ parentId }) => parentId === firstParent.body.id)
        .map(({ position }) => position),
    ).toEqual([0, 1]);
    expect(
      listed
        .filter(({ parentId }) => parentId === secondParent.body.id)
        .map(({ id, position }) => [id, position]),
    ).toEqual([[first.body.id, 0]]);

    await request(app)
      .patch(`/api/v1/categories/${first.body.id as string}`)
      .send({ parentId: null })
      .expect(200);
    await request(app)
      .patch(`/api/v1/categories/${first.body.id as string}`)
      .send({ parentId: secondParent.body.id })
      .expect(200);

    const duplicateAtSource = await createCategory(
      "Move collision",
      firstParent.body.id as string,
    );
    const duplicateAtDestination = await createCategory(
      " move collision ",
      secondParent.body.id as string,
    );
    expect(duplicateAtSource.status).toBe(201);
    expect(duplicateAtDestination.status).toBe(201);
    await request(app)
      .patch(`/api/v1/categories/${duplicateAtSource.body.id as string}`)
      .send({ parentId: secondParent.body.id })
      .expect(409, {
        error: {
          code: "conflict",
          message: "Category name already exists among its siblings",
        },
      });

    await request(app)
      .put("/api/v1/categories/reorder")
      .send({
        parentId: firstParent.body.id,
        categoryIds: [second.body.id],
      })
      .expect(400, {
        error: {
          code: "validation_error",
          message: "categoryIds must contain every sibling exactly once",
        },
      });
  });

  it("computes effective archival without overwriting child state", async () => {
    const parent = await createCategory("Archive parent");
    const activeChild = await createCategory(
      "Active child",
      parent.body.id as string,
    );
    const archivedChild = await createCategory(
      "Archived child",
      parent.body.id as string,
    );
    for (const response of [parent, activeChild, archivedChild])
      expect(response.status).toBe(201);
    await request(app)
      .post(`/api/v1/categories/${archivedChild.body.id as string}/archive`)
      .expect(200);
    await request(app)
      .post(`/api/v1/categories/${parent.body.id as string}/archive`)
      .expect(200);

    const whileArchived = await categories();
    expect(
      whileArchived.find(({ id }) => id === activeChild.body.id),
    ).toMatchObject({ archivedAt: null, isEffectivelyActive: false });
    expect(
      whileArchived.find(({ id }) => id === archivedChild.body.id),
    ).toMatchObject({
      archivedAt: expect.any(String),
      isEffectivelyActive: false,
    });
    await request(app)
      .post(`/api/v1/categories/${activeChild.body.id as string}/restore`)
      .expect(400, {
        error: {
          code: "validation_error",
          message:
            "A child category cannot be restored while its parent is archived",
        },
      });
    await request(app)
      .post(`/api/v1/categories/${parent.body.id as string}/restore`)
      .expect(200);
    const restored = await categories();
    expect(restored.find(({ id }) => id === activeChild.body.id)).toMatchObject(
      { archivedAt: null, isEffectivelyActive: true },
    );
    expect(
      restored.find(({ id }) => id === archivedChild.body.id),
    ).toMatchObject({
      archivedAt: expect.any(String),
      isEffectivelyActive: false,
    });
  });

  it("validates assignments while preserving historical direct assignments", async () => {
    const parent = await createCategory("Historically direct");
    expect(parent.status).toBe(201);
    const receipt = await createReceipt([
      {
        description: "Legacy direct line",
        lineTotalCents: 100,
        categoryId: parent.body.id,
      },
    ]);
    expect(receipt.status).toBe(201);
    expect(receipt.body.lineItems[0]).toMatchObject({
      categoryId: parent.body.id,
    });
    const historicalItemId = receipt.body.lineItems[0].id as string;

    const child = await createCategory(
      "First new child",
      parent.body.id as string,
    );
    expect(child.status).toBe(201);
    expect(
      (await categories()).find(({ id }) => id === parent.body.id),
    ).toMatchObject({ isLeaf: false, isAssignable: false });
    await createReceipt([
      {
        description: "Invalid new direct line",
        lineTotalCents: 100,
        categoryId: parent.body.id,
      },
    ]).expect(400, {
      error: {
        code: "validation_error",
        message:
          "categoryId must reference an effectively active leaf category",
      },
    });
    await request(app)
      .patch(`/api/v1/receipts/${receipt.body.id as string}`)
      .send({
        lineItems: [
          {
            id: historicalItemId,
            description: "Edited legacy line",
            lineTotalCents: 100,
            categoryId: parent.body.id,
          },
        ],
      })
      .expect(200)
      .expect((response) =>
        expect(response.body.lineItems[0]).toMatchObject({
          id: historicalItemId,
          description: "Edited legacy line",
          categoryId: parent.body.id,
        }),
      );
    await request(app)
      .patch(`/api/v1/receipts/${receipt.body.id as string}`)
      .send({
        lineItems: [
          {
            description: "Not historical",
            lineTotalCents: 100,
            categoryId: parent.body.id,
          },
        ],
      })
      .expect(400);

    const destination = await createCategory("Move-away destination");
    expect(destination.status).toBe(201);
    await request(app)
      .patch(`/api/v1/categories/${child.body.id as string}`)
      .send({ parentId: destination.body.id })
      .expect(200);
    expect(
      (await categories()).find(({ id }) => id === parent.body.id),
    ).toMatchObject({ isLeaf: true, isAssignable: true });
    await createReceipt([
      {
        description: "Direct again",
        lineTotalCents: 100,
        categoryId: parent.body.id,
      },
    ]).expect(201);
  });

  it("rejects unknown, archived, effectively archived, and non-leaf assignments", async () => {
    const parent = await createCategory("Assignment parent");
    const child = await createCategory(
      "Assignment child",
      parent.body.id as string,
    );
    expect(parent.status).toBe(201);
    expect(child.status).toBe(201);
    await request(app)
      .post(`/api/v1/categories/${parent.body.id as string}/archive`)
      .expect(200);
    const individuallyArchived = await createCategory("Archived leaf");
    expect(individuallyArchived.status).toBe(201);
    await request(app)
      .post(
        `/api/v1/categories/${individuallyArchived.body.id as string}/archive`,
      )
      .expect(200);
    for (const categoryId of [
      "clx0000000000000000000000",
      parent.body.id as string,
      child.body.id as string,
      individuallyArchived.body.id as string,
    ]) {
      await createReceipt([
        { description: "Invalid", lineTotalCents: 100, categoryId },
      ]).expect(400, {
        error: {
          code: "validation_error",
          message:
            "categoryId must reference an effectively active leaf category",
        },
      });
    }
  });

  it("restricts deletion and closes sibling gaps after a legal delete", async () => {
    const parent = await createCategory("Deletion parent");
    const first = await createCategory(
      "Delete first",
      parent.body.id as string,
    );
    const second = await createCategory(
      "Delete second",
      parent.body.id as string,
    );
    const third = await createCategory(
      "Delete third",
      parent.body.id as string,
    );
    for (const response of [parent, first, second, third])
      expect(response.status).toBe(201);
    await request(app)
      .delete(`/api/v1/categories/${parent.body.id as string}`)
      .expect(409, {
        error: {
          code: "conflict",
          message: "Category still has children or line-item assignments",
        },
      });
    await createReceipt([
      {
        description: "Assigned",
        lineTotalCents: 100,
        categoryId: first.body.id,
      },
    ]).expect(201);
    await request(app)
      .delete(`/api/v1/categories/${first.body.id as string}`)
      .expect(409);
    await request(app)
      .delete(`/api/v1/categories/${second.body.id as string}`)
      .expect(204);
    expect(
      (await categories())
        .filter(({ parentId }) => parentId === parent.body.id)
        .map(({ id, position }) => [id, position]),
    ).toEqual([
      [first.body.id, 0],
      [third.body.id, 1],
    ]);
    await request(app)
      .delete("/api/v1/categories/clx0000000000000000000000")
      .expect(404, {
        error: { code: "not_found", message: "Category not found" },
      });

    const soleParent = await createCategory("Sole-child parent");
    const soleChild = await createCategory(
      "Sole child",
      soleParent.body.id as string,
    );
    expect(soleParent.status).toBe(201);
    expect(soleChild.status).toBe(201);
    await request(app)
      .delete(`/api/v1/categories/${soleChild.body.id as string}`)
      .expect(204);
    expect(
      (await categories()).find(({ id }) => id === soleParent.body.id),
    ).toMatchObject({ isLeaf: true, isAssignable: true });
  });
});
