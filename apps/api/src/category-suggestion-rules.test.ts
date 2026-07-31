import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@receipt-report/database";
import type { Express } from "express";
import { createApp } from "./app.js";

let database: Database;
let directory: string;
let app: Express;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "receipt-report-rules-"));
  const databaseUrl = `file:${join(directory, "rules.db")}`;
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
  await database.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

async function category(name: string, parentId: string | null = null) {
  return request(app)
    .post("/api/v1/categories")
    .send({ name, parentId })
    .expect(201);
}

function rule(
  description: string,
  categoryId: string,
  scope: Record<string, unknown> = {
    scopeKind: "global",
    brandId: null,
    storeId: null,
  },
) {
  return request(app)
    .post("/api/v1/category-suggestion-rules")
    .send({ description, categoryId, ...scope });
}

describe("category suggestion rules", () => {
  it("normalizes exact descriptions and applies store, brand, global precedence", async () => {
    const globalCategory = await category("Rule global");
    const brandCategory = await category("Rule brand");
    const storeCategory = await category("Rule store");
    const brand = await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "Synthetic brand" })
      .expect(201);
    const store = await request(app)
      .post("/api/v1/merchant-stores")
      .send({ brandId: brand.body.id, name: "Synthetic store" })
      .expect(201);
    await rule("  ÄPFEL  BIO ", globalCategory.body.id).expect(201);
    await rule("äpfel bio", brandCategory.body.id, {
      scopeKind: "brand",
      brandId: brand.body.id,
      storeId: null,
    }).expect(201);
    await rule("Äpfel\tBio", storeCategory.body.id, {
      scopeKind: "store",
      brandId: brand.body.id,
      storeId: store.body.id,
    }).expect(201);

    const suggest = (query: string) =>
      request(app).get(
        `/api/v1/category-suggestion-rules/suggestion?description=${encodeURIComponent("äpfel bio")}${query}`,
      );
    expect((await suggest("")).body.suggestion.categoryId).toBe(
      globalCategory.body.id,
    );
    expect(
      (await suggest(`&brandId=${brand.body.id as string}`)).body.suggestion
        .categoryId,
    ).toBe(brandCategory.body.id);
    expect(
      (
        await suggest(
          `&brandId=${brand.body.id as string}&storeId=${store.body.id as string}`,
        )
      ).body.suggestion.categoryId,
    ).toBe(storeCategory.body.id);
  });

  it("enforces unconditional uniqueness and scope/store validity", async () => {
    const target = await category("Rule target");
    const brand = await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "Rule brand" })
      .expect(201);
    const other = await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "Other brand" })
      .expect(201);
    const store = await request(app)
      .post("/api/v1/merchant-stores")
      .send({ brandId: brand.body.id, name: "Rule store" })
      .expect(201);
    await rule("Milk", target.body.id).expect(201);
    await rule(" milk ", target.body.id).expect(409);
    await rule("Bread", target.body.id, {
      scopeKind: "store",
      brandId: other.body.id,
      storeId: store.body.id,
    }).expect(400);
    await rule("Bread", target.body.id, {
      scopeKind: "brand",
      brandId: null,
      storeId: null,
    }).expect(400);
  });

  it("flags drift, excludes invalid rules, preserves uniqueness, and permits repair", async () => {
    const target = await category("Temporary target");
    const replacement = await category("Replacement target");
    const created = await rule("Sensitive synthetic item", target.body.id);
    expect(created.status).toBe(201);
    await request(app)
      .post(`/api/v1/categories/${target.body.id as string}/archive`)
      .expect(200);
    const listed = await request(app)
      .get("/api/v1/category-suggestion-rules?validity=invalid")
      .expect(200);
    expect(listed.body.rules[0]).toMatchObject({
      id: created.body.id,
      isValid: false,
      invalidReason: "Target category is archived",
    });
    await request(app)
      .get(
        `/api/v1/category-suggestion-rules/suggestion?description=${encodeURIComponent("Sensitive synthetic item")}`,
      )
      .expect(200, { suggestion: null });
    await rule("sensitive synthetic item", replacement.body.id).expect(409);
    await request(app)
      .patch(`/api/v1/category-suggestion-rules/${created.body.id as string}`)
      .send({
        description: "Sensitive synthetic item",
        categoryId: replacement.body.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      })
      .expect(200)
      .expect((response) => expect(response.body.isValid).toBe(true));
  });

  it("lists, searches, filters, pages, edits, deletes, and restricts referenced identities", async () => {
    const first = await category("Rule first");
    const second = await category("Rule second");
    const brand = await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "Deletion brand" })
      .expect(201);
    const store = await request(app)
      .post("/api/v1/merchant-stores")
      .send({ brandId: brand.body.id, name: "Deletion store" })
      .expect(201);
    const created = await rule("Zebra item", first.body.id, {
      scopeKind: "store",
      brandId: brand.body.id,
      storeId: store.body.id,
    }).expect(201);
    await rule("Alpha item", second.body.id).expect(201);
    const firstPage = await request(app)
      .get("/api/v1/category-suggestion-rules?limit=1")
      .expect(200);
    expect(firstPage.body.rules[0].description).toBe("Alpha item");
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    await request(app)
      .get(
        `/api/v1/category-suggestion-rules?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor as string)}`,
      )
      .expect(200)
      .expect((response) =>
        expect(response.body.rules[0].description).toBe("Zebra item"),
      );
    await request(app)
      .get("/api/v1/category-suggestion-rules?query=zebra&scopeKind=store")
      .expect(200)
      .expect((response) => expect(response.body.rules).toHaveLength(1));
    await request(app)
      .delete(`/api/v1/categories/${first.body.id as string}`)
      .expect(409);
    await request(app)
      .delete(`/api/v1/merchant-stores/${store.body.id as string}`)
      .expect(409);
    await request(app)
      .delete(`/api/v1/merchant-brands/${brand.body.id as string}`)
      .expect(409);
    await request(app)
      .delete(`/api/v1/category-suggestion-rules/${created.body.id as string}`)
      .expect(204);
    await request(app)
      .get(`/api/v1/category-suggestion-rules/${created.body.id as string}`)
      .expect(404);
  });

  it("rejects invalid targets on create and update", async () => {
    const parent = await category("Rule parent");
    const child = await category("Rule child", parent.body.id);
    const archived = await category("Rule archived");
    await request(app)
      .post(`/api/v1/categories/${archived.body.id as string}/archive`)
      .expect(200);
    await rule("Parent", parent.body.id).expect(400);
    await rule("Archived", archived.body.id).expect(400);
    const created = await rule("Child", child.body.id).expect(201);
    await request(app)
      .patch(`/api/v1/category-suggestion-rules/${created.body.id as string}`)
      .send({
        description: "Child",
        categoryId: parent.body.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      })
      .expect(400);
  });

  it("returns stable failures for cursors, unknown merchant identities, and update conflicts", async () => {
    const first = await category("Failure target A");
    const second = await category("Failure target B");
    const one = await rule("Conflict one", first.body.id).expect(201);
    await rule("Conflict two", second.body.id).expect(201);
    await request(app)
      .patch(`/api/v1/category-suggestion-rules/${one.body.id as string}`)
      .send({
        description: "Conflict two",
        categoryId: first.body.id,
        scopeKind: "global",
        brandId: null,
        storeId: null,
      })
      .expect(409);
    for (const cursor of [
      "garbage",
      Buffer.from("null").toString("base64url"),
      Buffer.from("{}").toString("base64url"),
      Buffer.from(
        JSON.stringify({
          normalizedDescription: "x",
          scopeSpecificity: 1.5,
          id: "",
        }),
      ).toString("base64url"),
    ]) {
      await request(app)
        .get(
          `/api/v1/category-suggestion-rules?cursor=${encodeURIComponent(cursor)}`,
        )
        .expect(400, {
          error: {
            code: "invalid_cursor",
            message: "Invalid pagination cursor",
          },
        });
    }
    await request(app)
      .get(
        "/api/v1/category-suggestion-rules/suggestion?description=x&brandId=cm99999999999999999999999",
      )
      .expect(400);
    await request(app)
      .get(
        "/api/v1/category-suggestion-rules/suggestion?description=x&brandId=cm99999999999999999999998&storeId=cm99999999999999999999999",
      )
      .expect(400);
    await request(app)
      .get("/api/v1/category-suggestion-rules?validity=valid")
      .expect(200)
      .expect((response) => expect(response.body.rules).toHaveLength(2));
  });

  it("flags targets that gain children or an archived parent", async () => {
    const parent = await category("Drift parent");
    const child = await category("Drift nested child", parent.body.id);
    const standalone = await category("Drift standalone");
    const parentRule = await rule("Parent drift", child.body.id).expect(201);
    const standaloneRule = await rule("Leaf drift", standalone.body.id).expect(
      201,
    );
    await category("Drift child", standalone.body.id);
    await request(app)
      .post(`/api/v1/categories/${parent.body.id as string}/archive`)
      .expect(200);
    await request(app)
      .get("/api/v1/category-suggestion-rules?validity=invalid")
      .expect(200)
      .expect((response) => {
        expect(response.body.rules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: parentRule.body.id,
              invalidReason: "Target category has an archived parent",
            }),
            expect.objectContaining({
              id: standaloneRule.body.id,
              invalidReason: "Target category is no longer a leaf",
            }),
          ]),
        );
      });
  });
});
