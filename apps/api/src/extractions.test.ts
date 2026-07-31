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
  directory = await mkdtemp(join(tmpdir(), "extraction-api-"));
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

async function seed(status: "complete" | "pending" = "complete") {
  const receipt = await database.receipt.create({
    data: {
      merchantRaw: "Synthetic API",
      purchaseDate: "2026-07-31",
      totalCents: 1,
    },
  });
  const document = await database.receiptDocument.create({
    data: {
      receiptId: receipt.id,
      relativePath: `originals/${receipt.id}/original.png`,
      mediaType: "image/png",
      byteSize: 1,
      sha256: receipt.id.padEnd(64, "a").slice(0, 64),
      normalizationStatus: status,
      normalizationProfileVersion:
        status === "complete" ? "receipt-page-v1" : null,
      normalizationRevision: status === "complete" ? "revision-1" : null,
      ...(status === "complete"
        ? {
            pages: {
              create: {
                pageNumber: 1,
                totalPages: 1,
                relativePath: `pages/${receipt.id}/revision-1/page-0001.png`,
                mediaType: "image/png",
                byteSize: 1,
                width: 1,
                height: 1,
                sha256: "b".repeat(64),
                profileVersion: "receipt-page-v1",
                renderer: "synthetic/1",
              },
            },
          }
        : {}),
    },
  });
  return { receipt, document };
}

function app() {
  return createApp({
    database,
    extractionConfig: { maxAttempts: 3, profileVersion: "de-receipt-v1" },
  });
}

describe("extraction job API", () => {
  it("enqueues idempotently and returns only sanitized status", async () => {
    const { receipt, document } = await seed();
    const first = await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction`)
      .expect(202);
    expect(first.body).toMatchObject({
      documentId: document.id,
      normalizationRevision: "revision-1",
      status: "pending",
      attempts: 0,
      maxAttempts: 3,
      currentAttempt: null,
    });
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction`)
      .expect(202);
    expect(await database.extractionJob.count()).toBe(1);

    const job = await database.extractionJob.findFirstOrThrow();
    await database.extractionAttempt.create({
      data: {
        jobId: job.id,
        attemptNumber: 1,
        provider: "fake",
        model: "fake-v1",
        extractionProfileVersion: "de-receipt-v1",
        status: "succeeded",
        completedAt: new Date(),
        durationMs: 5,
        rawProviderOutput: "sensitive raw receipt",
        validatedOutput: "sensitive validated receipt",
      },
    });
    const status = await request(app())
      .get(`/api/v1/receipts/${receipt.id}/document/extraction`)
      .expect(200);
    expect(status.body.currentAttempt).toMatchObject({
      provider: "fake",
      model: "fake-v1",
      durationMs: 5,
    });
    expect(JSON.stringify(status.body)).not.toContain("sensitive");
    expect(JSON.stringify(status.body)).not.toContain("pages/");
  });

  it("rejects missing, incomplete, and running inputs with stable errors", async () => {
    await request(app())
      .post("/api/v1/receipts/clx0000000000000000000000/document/extraction")
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe("not_found"));
    const { receipt } = await seed("pending");
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction`)
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("conflict"));
  });

  it("retries terminal failures idempotently but rejects live work", async () => {
    const { receipt, document } = await seed();
    const job = await database.extractionJob.create({
      data: {
        documentId: document.id,
        normalizationRevision: "revision-1",
        normalizationProfileVersion: "receipt-page-v1",
        extractionProfileVersion: "de-receipt-v1",
        status: "failed",
        attempts: 3,
        maxAttempts: 3,
        lastErrorKind: "timeout",
      },
    });
    const retried = await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction/retry`)
      .expect(202);
    expect(retried.body).toMatchObject({
      status: "pending",
      attempts: 3,
      maxAttempts: 6,
      lastErrorKind: null,
    });
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction/retry`)
      .expect(202);

    await database.extractionJob.update({
      where: { id: job.id },
      data: { status: "running", claimToken: "live", claimedAt: new Date() },
    });
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction/retry`)
      .expect(409);
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction`)
      .expect(409);
  });

  it("explicitly backfills a previously normalized document revision", async () => {
    const { receipt } = await seed();
    expect(await database.extractionJob.count()).toBe(0);
    await request(app())
      .post(`/api/v1/receipts/${receipt.id}/document/extraction`)
      .expect(202);
    expect(await database.extractionJob.count()).toBe(1);
  });
});
