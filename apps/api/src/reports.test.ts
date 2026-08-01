import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@receipt-report/database";
import { createApp } from "./app.js";

let directory = "";
let database: Database;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "reports-api-"));
  const url = `file:${join(directory, "test.db")}`;
  execFileSync(
    "pnpm",
    ["--filter", "@receipt-report/database", "db:migrate:deploy"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    },
  );
  database = await createDatabase(url);
});
afterEach(async () => {
  await database.$disconnect();
  await rm(directory, { recursive: true, force: true });
});
const app = () =>
  createApp({
    database,
    extractionConfig: { maxAttempts: 3, profileVersion: "de-receipt-v1" },
  });

async function receipt(
  name: string,
  date: string,
  totalCents: number,
  options: {
    netCents?: number | null;
    taxCents?: number | null;
    categoryId?: string | null;
    brandId?: string;
    storeId?: string;
  } = {},
) {
  return database.receipt.create({
    data: {
      merchantRaw: name,
      purchaseDate: date,
      totalCents,
      ...(options.netCents === undefined ? {} : { netCents: options.netCents }),
      ...(options.taxCents === undefined ? {} : { taxCents: options.taxCents }),
      ...(options.brandId ? { merchantBrandId: options.brandId } : {}),
      ...(options.storeId ? { merchantStoreId: options.storeId } : {}),
      lineItems: {
        create: {
          description: `${name} item`,
          lineTotalCents: totalCents - 1,
          position: 0,
          categoryId: options.categoryId ?? null,
        },
      },
    },
  });
}

async function proposals(
  receiptId: string,
  count: number,
  finalStatus = "approved",
) {
  const document = await database.receiptDocument.create({
    data: {
      receiptId,
      relativePath: `reports/${receiptId}.png`,
      mediaType: "image/png",
      byteSize: 1,
      sha256: receiptId.padEnd(64, "f").slice(0, 64),
      normalizationStatus: "complete",
      normalizationProfileVersion: "receipt-page-v1",
      normalizationRevision: `rev-${receiptId}`,
    },
  });
  const job = await database.extractionJob.create({
    data: {
      documentId: document.id,
      normalizationRevision: `rev-${receiptId}`,
      normalizationProfileVersion: "receipt-page-v1",
      extractionProfileVersion: "de-receipt-v1",
      status: "succeeded",
      attempts: count,
      maxAttempts: 3,
    },
  });
  for (let index = 0; index < count; index++) {
    const attempt = await database.extractionAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: index + 1,
        provider: "fake",
        model: "fake-v1",
        extractionProfileVersion: "de-receipt-v1",
        status: "succeeded",
      },
    });
    await database.extractionProposal.create({
      data: {
        receiptId,
        documentId: document.id,
        attemptId: attempt.id,
        normalizationRevision: `rev-${receiptId}`,
        extractionProfileVersion: "de-receipt-v1",
        snapshot: "{}",
        status: index === count - 1 ? finalStatus : "approved",
      },
    });
  }
  return { document, job };
}

describe("spending reports", () => {
  it("returns cent-accurate totals, explicit coverage, and reconciling stable breakdowns", async () => {
    const parent = await database.category.create({
      data: {
        name: "Report food",
        normalizedName: "report food",
        position: 900,
      },
    });
    const child = await database.category.create({
      data: {
        name: "Report fruit",
        normalizedName: "report fruit",
        position: 900,
        parentId: parent.id,
      },
    });
    const brand = await database.merchantBrand.create({
      data: { name: "Markt", normalizedName: "markt" },
    });
    const store = await database.merchantStore.create({
      data: {
        brandId: brand.id,
        name: "Markt Mitte",
        normalizedName: "markt mitte",
        normalizedAddressKey: "",
      },
    });
    await receipt("Manual", "2026-01-31", 100, {
      netCents: 80,
      taxCents: 20,
      categoryId: child.id,
    });
    const approved = await receipt("AI Markt", "2026-02-01", 201, {
      categoryId: null,
      brandId: brand.id,
      storeId: store.id,
    });
    await proposals(approved.id, 1);
    const reprocessed = await receipt("AI Markt", "2026-02-10", 302, {
      netCents: 250,
      taxCents: 52,
      categoryId: parent.id,
      brandId: brand.id,
      storeId: store.id,
    });
    await proposals(reprocessed.id, 2);
    const response = await request(app())
      .get("/api/v1/reports/spending?from=2026-01-01&to=2026-02-28")
      .expect(200);
    expect(response.body).toMatchObject({
      timezone: "Europe/Berlin",
      totals: {
        grossCents: 603,
        receiptCount: 3,
        averageReceiptCents: 201,
        netCents: 330,
        taxCents: 72,
        coverage: { receipts: 3, net: 2, tax: 2 },
      },
    });
    for (const name of [
      "monthly",
      "categories",
      "merchantBrands",
      "merchantStores",
      "rawMerchants",
    ])
      expect(
        response.body[name].reduce(
          (sum: number, item: { grossCents: number }) => sum + item.grossCents,
          0,
        ),
      ).toBe(603);
    expect(response.body.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Report food (direct historical assignment)",
          grossCents: 301,
        }),
        expect.objectContaining({
          label: "Unallocated receipt adjustment",
          grossCents: 3,
        }),
      ]),
    );
    expect(
      response.body.categories.map(
        (item: { grossCents: number }) => item.grossCents,
      ),
    ).toEqual(
      [...response.body.categories]
        .map((item: { grossCents: number }) => item.grossCents)
        .sort((a: number, b: number) => b - a),
    );
    const adjustment = response.body.categories.find(
      (item: { key: string }) => item.key === "unallocated-adjustment",
    );
    const adjustmentList = await request(app())
      .get(adjustment.drillDownUrl)
      .expect(200);
    expect(adjustmentList.body.receipts).toHaveLength(3);
    const canonicalMerchant = await request(app())
      .get(
        `/api/v1/reports/spending?from=2026-01-01&to=2026-02-28&merchantBrandId=${brand.id}&merchantStoreId=${store.id}`,
      )
      .expect(200);
    expect(canonicalMerchant.body.totals).toMatchObject({
      grossCents: 503,
      receiptCount: 2,
    });
    const unassignedBrand = response.body.merchantBrands.find(
      (item: { key: string }) => item.key === "unassigned",
    );
    const unassignedList = await request(app())
      .get(unassignedBrand.drillDownUrl)
      .expect(200);
    expect(unassignedList.body.receipts).toHaveLength(1);
  });

  it("composes subtree, merchant, query, date, and provenance filters", async () => {
    const parent = await database.category.create({
      data: {
        name: "Filter food",
        normalizedName: "filter food",
        position: 901,
      },
    });
    const child = await database.category.create({
      data: {
        name: "Filter fruit",
        normalizedName: "filter fruit",
        position: 901,
        parentId: parent.id,
      },
    });
    const one = await receipt("Target Markt", "2026-03-01", 101, {
      categoryId: child.id,
    });
    await proposals(one.id, 1);
    const two = await receipt("Target Markt", "2026-03-02", 202, {
      categoryId: parent.id,
    });
    await proposals(two.id, 2);
    await receipt("Other", "2026-03-03", 400, { categoryId: child.id });
    const filtered = await request(app())
      .get(
        `/api/v1/reports/spending?from=2026-03-01&to=2026-03-31&categoryId=${parent.id}&categorySubtree=true&merchantQuery=Target&provenance=ai_reprocessed`,
      )
      .expect(200);
    expect(filtered.body.totals).toMatchObject({
      grossCents: 201,
      receiptCount: 1,
    });
    const direct = await request(app())
      .get(
        `/api/v1/reports/spending?from=2026-03-01&to=2026-03-31&categoryId=${parent.id}&categorySubtree=false`,
      )
      .expect(200);
    expect(direct.body.totals.grossCents).toBe(201);
    const list = await request(app())
      .get(filtered.body.rawMerchants[0].drillDownUrl)
      .expect(200);
    expect(list.body.receipts.map((item: { id: string }) => item.id)).toEqual([
      two.id,
    ]);
  });

  it("scopes category-filtered amounts to matching lines on mixed receipts", async () => {
    const food = await database.category.create({
      data: {
        name: "Scoped food",
        normalizedName: "scoped food",
        position: 902,
      },
    });
    const household = await database.category.create({
      data: {
        name: "Scoped household",
        normalizedName: "scoped household",
        position: 903,
      },
    });
    await database.receipt.create({
      data: {
        merchantRaw: "Mixed Markt",
        purchaseDate: "2026-03-10",
        totalCents: 500,
        netCents: 420,
        taxCents: 80,
        lineItems: {
          create: [
            {
              description: "Food",
              lineTotalCents: 200,
              position: 0,
              categoryId: food.id,
            },
            {
              description: "Household",
              lineTotalCents: 300,
              position: 1,
              categoryId: household.id,
            },
          ],
        },
      },
    });
    const filtered = await request(app())
      .get(
        `/api/v1/reports/spending?from=2026-03-01&to=2026-03-31&categoryId=${food.id}`,
      )
      .expect(200);
    expect(filtered.body.totals).toEqual({
      grossCents: 200,
      receiptCount: 1,
      averageReceiptCents: 200,
      netCents: null,
      taxCents: null,
      coverage: { receipts: 1, net: 0, tax: 0 },
    });
    expect(filtered.body.categories).toEqual([
      expect.objectContaining({ key: food.id, grossCents: 200 }),
    ]);
    for (const name of [
      "monthly",
      "categories",
      "merchantBrands",
      "merchantStores",
      "rawMerchants",
    ])
      expect(
        filtered.body[name].reduce(
          (sum: number, item: { grossCents: number }) => sum + item.grossCents,
          0,
        ),
      ).toBe(200);
  });

  it("is explicit for empty ranges and rejects reversed dates", async () => {
    const empty = await request(app())
      .get("/api/v1/reports/spending?from=2025-01-01&to=2025-01-31")
      .expect(200);
    expect(empty.body.totals).toEqual({
      grossCents: 0,
      receiptCount: 0,
      averageReceiptCents: null,
      netCents: null,
      taxCents: null,
      coverage: { receipts: 0, net: 0, tax: 0 },
    });
    await request(app())
      .get("/api/v1/reports/spending?from=2026-02-01&to=2026-01-01")
      .expect(400);
  });

  it("keeps workflow states independent from financial amounts", async () => {
    const states = ["pending", "retry_wait", "running", "failed", "succeeded"];
    for (const status of states) {
      const item = await receipt(`State ${status}`, "2026-04-01", 100);
      const seeded = await proposals(
        item.id,
        1,
        status === "succeeded" ? "pending" : "rejected",
      );
      await database.extractionJob.update({
        where: { id: seeded.job.id },
        data: { status },
      });
    }
    const preparing = await receipt("Preparing", "2026-04-01", 100);
    const seeded = await proposals(preparing.id, 1, "rejected");
    await database.receiptDocument.update({
      where: { id: seeded.document.id },
      data: { normalizationStatus: "running" },
    });
    const normalizationFailed = await receipt(
      "Normalization failed",
      "2026-04-01",
      100,
    );
    const failedSeed = await proposals(normalizationFailed.id, 1, "rejected");
    await database.receiptDocument.update({
      where: { id: failedSeed.document.id },
      data: { normalizationStatus: "failed" },
    });
    await receipt("Manual without document", "2026-04-01", 100);
    const noJob = await receipt("Normalized without job", "2026-04-01", 100);
    await database.receiptDocument.create({
      data: {
        receiptId: noJob.id,
        relativePath: `reports/${noJob.id}.png`,
        mediaType: "image/png",
        byteSize: 1,
        sha256: noJob.id.padEnd(64, "e").slice(0, 64),
        normalizationStatus: "complete",
        normalizationProfileVersion: "receipt-page-v1",
        normalizationRevision: `rev-${noJob.id}`,
      },
    });
    const reviewed = await receipt("Already reviewed", "2026-04-01", 100);
    await proposals(reviewed.id, 1, "approved");
    const workflow = await request(app())
      .get("/api/v1/reports/workflow")
      .expect(200);
    expect(workflow.body).toEqual({
      preparing: 1,
      queued: 2,
      processing: 1,
      needsReview: 1,
      failed: 2,
    });
    for (const [state, count] of Object.entries({
      preparing: 1,
      queued: 2,
      processing: 1,
      "needs-review": 1,
      failed: 2,
    })) {
      const list = await request(app())
        .get(`/api/v1/receipts?workflow=${state}`)
        .expect(200);
      expect(list.body.receipts, state).toHaveLength(count);
    }
    const spend = await request(app())
      .get("/api/v1/reports/spending?from=2026-04-01&to=2026-04-01")
      .expect(200);
    expect(spend.body.totals).toMatchObject({
      receiptCount: 10,
      grossCents: 1000,
    });
  });

  it("uses the purchase-date index for bounded ranges", async () => {
    const plan = await database.$queryRawUnsafe<{ detail: string }[]>(
      "EXPLAIN QUERY PLAN SELECT id FROM Receipt WHERE purchaseDate >= ? AND purchaseDate <= ? ORDER BY purchaseDate, id",
      "2026-01-01",
      "2026-12-31",
    );
    expect(
      plan.some((row) => /Receipt_purchaseDate_id_idx/.test(row.detail)),
    ).toBe(true);
  });
});
