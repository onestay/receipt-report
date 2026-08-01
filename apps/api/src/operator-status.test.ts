import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { operatorStatusResponseSchema } from "@receipt-report/contracts";
import { createDatabase, type Database } from "@receipt-report/database";
import { createApp } from "./app.js";

let database: Database | undefined;
let directory: string | undefined;

afterEach(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("operator status API", () => {
  it("aggregates lifecycle states and marks stale work without leaking payloads", async () => {
    directory = await mkdtemp(join(tmpdir(), "receipt-operator-"));
    const databaseUrl = `file:${join(directory, "status.db")}`;
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
    const receipt = await database.receipt.create({
      data: {
        merchantRaw: "PRIVATE MARKER",
        purchaseDate: "2026-08-01",
        totalCents: 1,
      },
    });
    const document = await database.receiptDocument.create({
      data: {
        receiptId: receipt.id,
        relativePath: "private/source.pdf",
        mediaType: "application/pdf",
        byteSize: 1,
        sha256: "a".repeat(64),
        normalizationStatus: "pending",
      },
    });
    await database.normalizationJob.create({
      data: {
        documentId: document.id,
        profileVersion: "receipt-page-v1",
        status: "running",
      },
    });
    await database.normalizationJob.update({
      where: { documentId: document.id },
      data: { updatedAt: new Date("2026-07-01") },
    });
    await database.extractionJob.create({
      data: {
        documentId: document.id,
        normalizationRevision: "r1",
        normalizationProfileVersion: "receipt-page-v1",
        extractionProfileVersion: "de-receipt-v1",
        status: "retry_wait",
        maxAttempts: 5,
        lastErrorKind: "provider_authentication",
      },
    });
    const response = await request(
      createApp({ database, operatorStaleAfterMs: 1000 }),
    )
      .get("/api/v1/operator/status")
      .expect(200);
    expect(operatorStatusResponseSchema.parse(response.body)).toEqual(
      response.body,
    );
    expect(response.body).toMatchObject({
      status: "attention_required",
      normalization: { running: 1, stale: 1 },
      extraction: { retrying: 1 },
    });
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE MARKER");
    expect(JSON.stringify(response.body)).not.toContain(
      "provider_authentication",
    );
  });
});
