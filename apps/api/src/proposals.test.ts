import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@receipt-report/database";
import type { ProposalSnapshot } from "@receipt-report/contracts";
import { createApp } from "./app.js";
import { categoryQualityOutcome } from "./proposals.js";

let directory = "";
let database: Database;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "proposal-api-"));
  const databaseUrl = `file:${join(directory, "test.db")}`;
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
});
afterEach(async () => {
  await database.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

function app() {
  return createApp({
    database,
    extractionConfig: { maxAttempts: 3, profileVersion: "de-receipt-v2" },
  });
}
function snapshot(totalCents = 100): ProposalSnapshot {
  return {
    merchantRaw: "Synthetic Markt",
    merchantConfidence: 0.9,
    merchantBrandId: null,
    merchantStoreId: null,
    purchaseDate: "2026-07-31",
    purchaseDateConfidence: 0.9,
    purchaseTime: null,
    purchaseTimeConfidence: null,
    currency: "EUR",
    totalCents,
    totalConfidence: 0.9,
    netCents: 80,
    taxCents: 20,
    lineItems: [
      {
        sourcePosition: 0,
        description: "Pfand",
        descriptionConfidence: 0.9,
        quantityMilli: 1000,
        unitPriceCents: 150,
        lineTotalCents: 150,
        categoryId: null,
        categorySuggestion: null,
        kind: "deposit",
      },
      {
        sourcePosition: 1,
        description: "Pfandrückgabe",
        descriptionConfidence: 0.9,
        quantityMilli: 1000,
        unitPriceCents: -50,
        lineTotalCents: -50,
        categoryId: null,
        categorySuggestion: null,
        kind: "deposit_refund",
      },
    ],
  };
}
async function seed(proposalSnapshot = snapshot()) {
  const receipt = await database.receipt.create({
    data: { merchantRaw: "Before", purchaseDate: "2026-07-01", totalCents: 1 },
  });
  const document = await database.receiptDocument.create({
    data: {
      receiptId: receipt.id,
      relativePath: `originals/${receipt.id}.png`,
      mediaType: "image/png",
      byteSize: 1,
      sha256: receipt.id.padEnd(64, "a").slice(0, 64),
      normalizationStatus: "complete",
      normalizationProfileVersion: "receipt-page-v1",
      normalizationRevision: "revision-1",
    },
  });
  const job = await database.extractionJob.create({
    data: {
      documentId: document.id,
      normalizationRevision: "revision-1",
      normalizationProfileVersion: "receipt-page-v1",
      extractionProfileVersion: "de-receipt-v2",
      status: "succeeded",
      attempts: 1,
      maxAttempts: 3,
    },
  });
  const attempt = await database.extractionAttempt.create({
    data: {
      jobId: job.id,
      attemptNumber: 1,
      provider: "fake",
      model: "fake-v1",
      extractionProfileVersion: "de-receipt-v2",
      status: "succeeded",
    },
  });
  const proposal = await database.extractionProposal.create({
    data: {
      receiptId: receipt.id,
      documentId: document.id,
      attemptId: attempt.id,
      normalizationRevision: "revision-1",
      extractionProfileVersion: "de-receipt-v2",
      snapshot: JSON.stringify(proposalSnapshot),
    },
  });
  return { receipt, document, job, proposal };
}

describe("proposal API", () => {
  it.each([
    ["model", "unchanged", "category", "accepted_model"],
    ["model", "changed", "category", "corrected_model"],
    ["model", "value_removed", null, "cleared_model"],
    ["exact_rule", "missing_filled", "category", "exact_rule"],
    [null, "unchanged", null, "unassigned"],
    ["manual", "changed", "category", "manual"],
  ])(
    "classifies category feedback as %s",
    (provenance, correctionKind, accepted, expected) => {
      expect(categoryQualityOutcome(provenance, correctionKind, accepted)).toBe(
        expected,
      );
    },
  );
  it("returns the current sanitized proposal", async () => {
    const seeded = await seed();
    const response = await request(app())
      .get(`/api/v1/receipts/${seeded.receipt.id}/extraction-proposal`)
      .expect(200);
    expect(response.body).toMatchObject({
      id: seeded.proposal.id,
      status: "pending",
      snapshot: { merchantRaw: "Synthetic Markt" },
    });
    expect(JSON.stringify(response.body)).not.toContain("rawProviderOutput");
  });

  it("reports missing proposal and non-normalized reprocess states", async () => {
    const receipt = await database.receipt.create({
      data: {
        merchantRaw: "No document",
        purchaseDate: "2026-07-31",
        totalCents: 1,
      },
    });
    await request(app())
      .get(`/api/v1/receipts/${receipt.id}/extraction-proposal`)
      .expect(404);
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/extraction/reprocess`)
      .expect(409);
    await request(app())
      .get("/api/v1/receipts/clx0000000000000000000000/extraction-proposal")
      .expect(404);
  });

  it("approves atomically with signed kinds, nullable totals, and immutable history", async () => {
    const seeded = await seed();
    const receipt = await database.receipt.findUniqueOrThrow({
      where: { id: seeded.receipt.id },
    });
    await request(app())
      .post(
        `/api/v1/receipts/${receipt.id}/extraction-proposals/${seeded.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: snapshot(),
        acknowledgedWarningCodes: [],
      })
      .expect(200);
    const stored = await database.receipt.findUniqueOrThrow({
      where: { id: receipt.id },
      include: { lineItems: { orderBy: { position: "asc" } } },
    });
    expect(stored).toMatchObject({
      merchantRaw: "Synthetic Markt",
      totalCents: 100,
      netCents: 80,
      taxCents: 20,
    });
    expect(stored.lineItems).toMatchObject([
      { lineTotalCents: 150, kind: "deposit" },
      { lineTotalCents: -50, kind: "deposit_refund" },
    ]);
    const history = await request(app())
      .get(`/api/v1/receipts/${receipt.id}/extraction-proposals`)
      .expect(200);
    expect(history.body.decisions[0]).toMatchObject({
      kind: "approved",
      actor: "local-user",
    });
    expect(JSON.stringify(history.body)).not.toContain("rawProviderOutput");
    const events = await database.correctionEvent.findMany({
      where: { proposalId: seeded.proposal.id },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        fieldPath: "merchantRaw",
        correctionKind: "unchanged",
        provider: "fake",
        model: "fake-v1",
      }),
    );
  });

  it("rejects a non-ISO proposal date at the approval boundary", async () => {
    const seeded = await seed({ ...snapshot(), purchaseDate: "31.07.2026" });
    const receipt = await database.receipt.findUniqueOrThrow({
      where: { id: seeded.receipt.id },
    });
    await request(app())
      .post(
        `/api/v1/receipts/${receipt.id}/extraction-proposals/${seeded.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: { ...snapshot(), purchaseDate: "31.07.2026" },
        acknowledgedWarningCodes: [],
      })
      .expect(400);
    expect(
      await database.receipt.findUniqueOrThrow({ where: { id: receipt.id } }),
    ).toMatchObject({ purchaseDate: "2026-07-01" });
  });

  it("records idempotent corrections and reproducible filtered quality", async () => {
    const emptyQuality = await request(app())
      .get("/api/v1/extraction-quality")
      .expect(200);
    expect(emptyQuality.body.totals).toMatchObject({
      proposedFields: 0,
      correctionRate: 0,
    });
    const seeded = await seed();
    const accepted = snapshot();
    accepted.purchaseTime = "10:30";
    accepted.netCents = null;
    const first = accepted.lineItems[0];
    if (!first) throw new Error("Missing line fixture");
    first.description = "Mehrwegpfand";
    const body = {
      receiptUpdatedAt: seeded.receipt.updatedAt.toISOString(),
      normalizationRevision: "revision-1",
      snapshot: accepted,
      acknowledgedWarningCodes: [],
    };
    const path = `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/approve`;
    await request(app()).post(path).send(body).expect(200);
    await request(app()).post(path).send(body).expect(200);
    const events = await database.correctionEvent.findMany({
      where: { proposalId: seeded.proposal.id },
    });
    expect(
      events.filter((item) => item.correctionKind !== "unchanged"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "purchaseTime",
          correctionKind: "missing_filled",
        }),
        expect.objectContaining({
          fieldPath: "lineItems.0.description",
          correctionKind: "changed",
        }),
      ]),
    );
    expect(await database.extractionDecision.count()).toBe(1);
    const quality = await request(app())
      .get(
        "/api/v1/extraction-quality?profileVersion=de-receipt-v2&model=fake-v1&fieldKind=purchaseTime&from=2026-01-01&to=2026-12-31",
      )
      .expect(200);
    expect(quality.body.totals).toMatchObject({
      proposedFields: 1,
      changedFields: 1,
      missingFilled: 1,
      correctionRate: 1,
    });
    expect(quality.body.buckets).toHaveLength(1);
    const unfiltered = await request(app())
      .get("/api/v1/extraction-quality?provider=fake&to=2026-12-31")
      .expect(200);
    expect(unfiltered.body.totals).toMatchObject({
      proposedFields: events.length,
      modelValuesRemoved: 1,
    });
  });

  it("accounts for model-prefilled categories through real approval", async () => {
    const category = await database.category.create({
      data: {
        name: "Synthetic model category",
        normalizedName: "synthetic model category",
        position: 950,
      },
    });
    const proposed = snapshot();
    const line = proposed.lineItems[0];
    if (!line) throw new Error("Missing line fixture");
    line.categoryId = category.id;
    line.categoryProvenance = "model";
    line.categoryConfidence = 0.9;
    const seeded = await seed(proposed);

    await request(app())
      .post(
        `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: seeded.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: proposed,
        acknowledgedWarningCodes: [],
      })
      .expect(200);

    await expect(
      database.correctionEvent.findFirstOrThrow({
        where: {
          proposalId: seeded.proposal.id,
          fieldKind: "lineItem.categoryId",
          sourcePosition: 0,
        },
      }),
    ).resolves.toMatchObject({ originalCategoryProvenance: "model" });
    const quality = await request(app())
      .get("/api/v1/extraction-quality")
      .expect(200);
    expect(quality.body.totals).toMatchObject({
      acceptedModelCategories: 1,
    });
  });

  it("revalidates edits and enforces warnings and receipt/document CAS", async () => {
    const blocking = await seed(snapshot(-1));
    await request(app())
      .post(
        `/api/v1/receipts/${blocking.receipt.id}/extraction-proposals/${blocking.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: blocking.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: snapshot(-1),
      })
      .expect(409);
    const warning = await seed({
      ...snapshot(),
      totalCents: 200,
      netCents: null,
      taxCents: null,
    });
    await request(app())
      .post(
        `/api/v1/receipts/${warning.receipt.id}/extraction-proposals/${warning.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: warning.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: {
          ...snapshot(),
          totalCents: 200,
          netCents: null,
          taxCents: null,
        },
      })
      .expect(409);
    await database.receipt.update({
      where: { id: warning.receipt.id },
      data: { notes: "human edit" },
    });
    await request(app())
      .post(
        `/api/v1/receipts/${warning.receipt.id}/extraction-proposals/${warning.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: warning.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: {
          ...snapshot(),
          totalCents: 200,
          netCents: null,
          taxCents: null,
        },
        acknowledgedWarningCodes: ["line_sum_mismatch"],
      })
      .expect(409);
  });

  it("accepts explicitly acknowledged warning codes", async () => {
    const edited = {
      ...snapshot(),
      totalCents: 200,
      netCents: null,
      taxCents: null,
    };
    const seeded = await seed(edited);
    const approval = await request(app())
      .post(
        `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: seeded.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: edited,
        acknowledgedWarningCodes: ["line_sum_mismatch"],
      });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    await expect(
      database.extractionDecision.findFirstOrThrow(),
    ).resolves.toMatchObject({
      acknowledgedWarnings: JSON.stringify(["line_sum_mismatch"]),
    });
  });

  it("approves valid merchant, store, and category references", async () => {
    const brand = await database.merchantBrand.create({
      data: { name: "Brand", normalizedName: "brand" },
    });
    const store = await database.merchantStore.create({
      data: {
        brandId: brand.id,
        name: "Store",
        normalizedName: "store",
        normalizedAddressKey: "",
      },
    });
    const category = await database.category.create({
      data: {
        name: "Synthetic leaf",
        normalizedName: "synthetic leaf",
        position: 999,
      },
    });
    const accepted = snapshot();
    accepted.merchantBrandId = brand.id;
    accepted.merchantStoreId = store.id;
    for (const line of accepted.lineItems) line.categoryId = category.id;
    const seeded = await seed(accepted);
    const referenceApproval = await request(app())
      .post(
        `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: seeded.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: accepted,
        acknowledgedWarningCodes: [],
      });
    expect(
      referenceApproval.status,
      JSON.stringify(referenceApproval.body),
    ).toBe(200);
    await expect(
      database.lineItem.count({ where: { categoryId: category.id } }),
    ).resolves.toBe(2);
  });

  it("rejects stale document revisions and invalid references", async () => {
    const stale = await seed();
    await request(app())
      .post(
        `/api/v1/receipts/${stale.receipt.id}/extraction-proposals/${stale.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: stale.receipt.updatedAt.toISOString(),
        normalizationRevision: "other-revision",
        snapshot: snapshot(),
      })
      .expect(409);
    const invalid = await seed();
    const firstBrand = await database.merchantBrand.create({
      data: { name: "First", normalizedName: "first" },
    });
    const secondBrand = await database.merchantBrand.create({
      data: { name: "Second", normalizedName: "second" },
    });
    const store = await database.merchantStore.create({
      data: {
        brandId: firstBrand.id,
        name: "Store",
        normalizedName: "store",
        normalizedAddressKey: "",
      },
    });
    await request(app())
      .post(
        `/api/v1/receipts/${invalid.receipt.id}/extraction-proposals/${invalid.proposal.id}/approve`,
      )
      .send({
        receiptUpdatedAt: invalid.receipt.updatedAt.toISOString(),
        normalizationRevision: "revision-1",
        snapshot: {
          ...snapshot(),
          merchantBrandId: secondBrand.id,
          merchantStoreId: store.id,
        },
      })
      .expect(400);

    const approveInvalidSnapshot = (candidate: ProposalSnapshot) =>
      request(app())
        .post(
          `/api/v1/receipts/${invalid.receipt.id}/extraction-proposals/${invalid.proposal.id}/approve`,
        )
        .send({
          receiptUpdatedAt: invalid.receipt.updatedAt.toISOString(),
          normalizationRevision: "revision-1",
          snapshot: candidate,
          acknowledgedWarningCodes: [],
        })
        .expect(400);
    await approveInvalidSnapshot({
      ...snapshot(),
      merchantStoreId: store.id,
    });
    await approveInvalidSnapshot({
      ...snapshot(),
      merchantBrandId: "clx0000000000000000000000",
    });
    await approveInvalidSnapshot({
      ...snapshot(),
      merchantBrandId: firstBrand.id,
      merchantStoreId: "clx0000000000000000000000",
    });

    const archived = await database.category.create({
      data: {
        name: "Archived",
        normalizedName: "archived",
        position: 1000,
        archivedAt: new Date(),
      },
    });
    const parent = await database.category.create({
      data: { name: "Parent", normalizedName: "parent", position: 1001 },
    });
    await database.category.create({
      data: {
        name: "Child",
        normalizedName: "child",
        position: 0,
        parentId: parent.id,
      },
    });
    const archivedParent = await database.category.create({
      data: {
        name: "Archived parent",
        normalizedName: "archived parent",
        position: 1002,
        archivedAt: new Date(),
      },
    });
    const activeChild = await database.category.create({
      data: {
        name: "Active child",
        normalizedName: "active child",
        position: 0,
        parentId: archivedParent.id,
      },
    });
    for (const categoryId of [
      "clx0000000000000000000000",
      archived.id,
      parent.id,
      activeChild.id,
    ]) {
      const candidate = snapshot();
      const firstLine = candidate.lineItems.at(0);
      if (!firstLine) throw new Error("Synthetic proposal requires a line");
      firstLine.categoryId = categoryId;
      await approveInvalidSnapshot(candidate);
    }
  });

  it("rejects duplicate decisions and active reprocessing", async () => {
    const seeded = await seed();
    await request(app())
      .post(
        `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/reject`,
      )
      .expect(200);
    await request(app())
      .post(
        `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/reject`,
      )
      .expect(409);
    await request(app())
      .post(`/api/v1/receipts/${seeded.receipt.id}/extraction/reprocess`)
      .expect(202);
    await request(app())
      .post(`/api/v1/receipts/${seeded.receipt.id}/extraction/reprocess`)
      .expect(409);
  });

  it("rejects without changing receipt and reprocesses without overwriting edits", async () => {
    const seeded = await seed();
    await request(app())
      .post(
        `/api/v1/receipts/${seeded.receipt.id}/extraction-proposals/${seeded.proposal.id}/reject`,
      )
      .expect(200);
    expect(
      (
        await database.receipt.findUniqueOrThrow({
          where: { id: seeded.receipt.id },
        })
      ).merchantRaw,
    ).toBe("Before");
    await database.receipt.update({
      where: { id: seeded.receipt.id },
      data: { merchantRaw: "Human authoritative" },
    });
    await request(app())
      .post(`/api/v1/receipts/${seeded.receipt.id}/extraction/reprocess`)
      .expect(202);
    expect(
      (
        await database.extractionJob.findUniqueOrThrow({
          where: { id: seeded.job.id },
        })
      ).status,
    ).toBe("pending");
    expect(
      (
        await database.receipt.findUniqueOrThrow({
          where: { id: seeded.receipt.id },
        })
      ).merchantRaw,
    ).toBe("Human authoritative");
  });
});
