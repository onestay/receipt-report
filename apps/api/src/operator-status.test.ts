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
  it("reports disabled email import with zero aggregate counts by default", async () => {
    directory = await mkdtemp(join(tmpdir(), "receipt-operator-empty-"));
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
    const response = await request(
      createApp({ database, operatorStaleAfterMs: 1000 }),
    )
      .get("/api/v1/operator/status")
      .expect(200);
    expect(response.body.emailImport).toEqual({
      enabled: false,
      lastSuccessfulPollAt: null,
      pending: 0,
      imported: 0,
      duplicate: 0,
      failed: 0,
    });
  });

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
        extractionProfileVersion: "de-receipt-v2",
        status: "retry_wait",
        maxAttempts: 5,
        lastErrorKind: "provider_authentication",
      },
    });
    const cursor = await database.emailImportCursor.create({
      data: {
        accountKey: "opaque-account",
        mailboxKey: "opaque-mailbox",
        uidValidity: "1",
      },
    });
    const message = await database.emailMessageImport.create({
      data: { cursorId: cursor.id, uid: 1, status: "complete" },
    });
    await database.emailAttachmentImport.createMany({
      data: [
        {
          messageId: message.id,
          partId: "1",
          ordinal: 0,
          originalFilename: "PRIVATE-FILENAME.pdf",
          status: "imported",
          receiptId: receipt.id,
          documentId: document.id,
        },
        {
          messageId: message.id,
          partId: "2",
          ordinal: 1,
          status: "retry_wait",
          failureCode: "PRIVATE-FAILURE",
        },
        {
          messageId: message.id,
          partId: "3",
          ordinal: 2,
          status: "pending",
        },
        {
          messageId: message.id,
          partId: "4",
          ordinal: 3,
          status: "running",
        },
        {
          messageId: message.id,
          partId: "5",
          ordinal: 4,
          status: "duplicate",
          receiptId: receipt.id,
          documentId: document.id,
        },
        {
          messageId: message.id,
          partId: "6",
          ordinal: 5,
          status: "failed",
        },
      ],
    });
    await database.emailImporterHealth.create({
      data: {
        id: "default",
        enabled: true,
        lastSuccessfulPollAt: new Date("2026-08-12T06:00:00.000Z"),
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
      emailImport: {
        enabled: true,
        lastSuccessfulPollAt: "2026-08-12T06:00:00.000Z",
        pending: 3,
        imported: 1,
        duplicate: 1,
        failed: 1,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE MARKER");
    expect(JSON.stringify(response.body)).not.toContain(
      "provider_authentication",
    );
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE-FILENAME");
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE-FAILURE");
  });
});
