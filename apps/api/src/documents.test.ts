import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  FilesystemDocumentStorage,
  normalizedPageRevisionPath,
  type Database,
} from "@receipt-report/database";
import { createApp } from "./app.js";
import { retryDocumentFileCleanup } from "./documents.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8,
  1, 1, 0, 0, 0x3f, 0, 0, 0xff, 0xd9,
]);
const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type /Catalog /Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type /Pages /Count 1 /Kids[3 0 R]>>endobj\n" +
    "3 0 obj<</Type /Page /Parent 2 0 R>>endobj\n" +
    "xref\n0 4\n0000000000 65535 f \ntrailer<</Root 1 0 R>>\n" +
    "startxref\n0\n%%EOF\n",
);

let directory = "";
let database: Database;
let storage: FilesystemDocumentStorage;

const documentConfig = {
  DOCUMENT_MAX_BYTES: 1024,
  DOCUMENT_MAX_REQUEST_BYTES: 2048,
  DOCUMENT_MAX_PDF_PAGES: 4,
  DOCUMENT_MAX_IMAGE_WIDTH: 100,
  DOCUMENT_MAX_IMAGE_HEIGHT: 100,
  DOCUMENT_MAX_DECODED_PIXELS: 10_000,
  DOCUMENT_VALIDATION_TIMEOUT_MS: 2_000,
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "receipt-upload-"));
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
  storage = new FilesystemDocumentStorage(join(directory, "documents"));
});

afterEach(async () => {
  await database.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

async function receipt(): Promise<string> {
  return (
    await database.receipt.create({
      data: {
        merchantRaw: "Synthetic",
        purchaseDate: "2026-07-21",
        totalCents: 1,
      },
    })
  ).id;
}

function app(config = documentConfig) {
  return createApp({
    database,
    documentStorage: storage,
    documentConfig: config,
  });
}

describe("receipt document API", () => {
  it("publishes the configured upload guidance", async () => {
    await request(app())
      .get("/api/v1/document-upload-configuration")
      .expect(200, {
        maxBytes: documentConfig.DOCUMENT_MAX_BYTES,
        acceptedMediaTypes: ["image/jpeg", "image/png", "application/pdf"],
      });
  });

  it.each([
    ["image.png", "application/octet-stream", png, "image/png"],
    ["image.jpg", "text/plain", jpeg, "image/jpeg"],
    ["document.pdf", "image/png", pdf, "application/pdf"],
  ])(
    "uploads and serves a structurally valid %s",
    async (filename, clientType, bytes, mediaType) => {
      const receiptId = await receipt();
      const uploaded = await request(app())
        .post(`/api/v1/receipts/${receiptId}/document`)
        .attach("document", bytes, { filename, contentType: clientType })
        .expect(201);
      expect(uploaded.body).toMatchObject({
        receiptId,
        originalFilename: filename,
        mediaType,
        byteSize: bytes.length,
        normalizationStatus: "pending",
        normalizationProfileVersion: null,
        pages: [],
      });
      expect(uploaded.body).not.toHaveProperty("relativePath");
      const row = await database.receiptDocument.findUniqueOrThrow({
        where: { receiptId },
      });
      expect(await storage.read(row.relativePath)).toEqual(bytes);
      await expect(
        database.normalizationJob.findUniqueOrThrow({
          where: { documentId: row.id },
        }),
      ).resolves.toMatchObject({
        status: "pending",
        profileVersion: "receipt-page-v1",
        attempts: 0,
      });
      await request(app())
        .get(uploaded.body.originalUrl)
        .expect(200)
        .expect("Content-Type", mediaType)
        .expect("X-Content-Type-Options", "nosniff")
        .expect(bytes);
    },
  );

  it("sanitizes display filenames and emits injection-safe headers", async () => {
    const receiptId = await receipt();
    const uploaded = await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, {
        filename: "../../evil\r\nX-Test: injected.png",
        contentType: "image/png",
      })
      .expect(201);
    expect(uploaded.body.originalFilename).toBe("evilX-Test: injected.png");
    const downloaded = await request(app())
      .get(uploaded.body.originalUrl)
      .expect(200);
    expect(downloaded.headers["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(JSON.stringify(uploaded.body)).not.toContain(directory);
  });

  it("rejects exact duplicates store-wide with stable ownership details", async () => {
    const firstReceipt = await receipt();
    const secondReceipt = await receipt();
    const first = await request(app())
      .post(`/api/v1/receipts/${firstReceipt}/document`)
      .attach("document", png, "one.png")
      .expect(201);
    await request(app())
      .post(`/api/v1/receipts/${secondReceipt}/document`)
      .attach("document", png, "two.png")
      .expect(409, {
        error: {
          code: "duplicate_document",
          message: "Document is already attached",
          details: { receiptId: firstReceipt, documentId: first.body.id },
        },
      });
    expect(await database.receiptDocument.count()).toBe(1);
  });

  it.each([
    ["empty", Buffer.alloc(0), "malformed_document", 400],
    ["unsupported", Buffer.from("hello"), "unsupported_document", 415],
    ["truncated PNG", png.subarray(0, 30), "malformed_document", 400],
    [
      "malformed PDF",
      Buffer.from("%PDF-1.4 broken"),
      "malformed_document",
      400,
    ],
  ])(
    "rejects %s input without durable state",
    async (_name, bytes, code, status) => {
      const receiptId = await receipt();
      const response = await request(app())
        .post(`/api/v1/receipts/${receiptId}/document`)
        .attach("document", bytes, "bad.bin")
        .expect(status);
      expect(response.body.error.code).toBe(code);
      expect(await database.receiptDocument.count()).toBe(0);
    },
  );

  it("rejects oversized and multi-file requests without durable state", async () => {
    const receiptId = await receipt();
    const limited = { ...documentConfig, DOCUMENT_MAX_BYTES: 32 };
    await request(app(limited))
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "large.png")
      .expect(413)
      .expect((response) =>
        expect(response.body.error.code).toBe("document_too_large"),
      );
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "one.png")
      .attach("document", jpeg, "two.jpg")
      .expect(400)
      .expect((response) =>
        expect(response.body.error.code).toBe("multipart_error"),
      );
    expect(await database.receiptDocument.count()).toBe(0);
  });

  it("records multipart rejection cleanup failures for retry", async () => {
    const receiptId = await receipt();
    class FailingStagingCleanupStorage extends FilesystemDocumentStorage {
      override async cleanup(path: string): Promise<void> {
        if (path.startsWith("staging/")) throw new Error("injected cleanup");
        await super.cleanup(path);
      }
    }
    storage = new FailingStagingCleanupStorage(storage.root);
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "one.png")
      .attach("document", jpeg, "two.jpg")
      .expect(400);
    const pending = await database.documentFileCleanup.findFirstOrThrow({
      where: { relativePath: { startsWith: "staging/" } },
    });
    expect(pending).toMatchObject({ lastError: "cleanup_failed" });
    storage = new FilesystemDocumentStorage(storage.root);
    await retryDocumentFileCleanup(database, storage);
    expect(await database.documentFileCleanup.count()).toBe(0);
    expect(await storage.exists(pending.relativePath)).toBe(false);
  });

  it("replaces only explicitly, promotes before cleanup, and removes safely", async () => {
    const receiptId = await receipt();
    const first = await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "first.png")
      .expect(201);
    const oldPath = (
      await database.receiptDocument.findUniqueOrThrow({ where: { receiptId } })
    ).relativePath;
    const pagePath = normalizedPageRevisionPath(
      first.body.id,
      "old-revision",
      1,
    );
    const stagedPage = await storage.stage(png, "worker");
    await storage.promote(stagedPage, pagePath);
    await database.receiptPage.create({
      data: {
        documentId: first.body.id,
        pageNumber: 1,
        totalPages: 1,
        relativePath: pagePath,
        mediaType: "image/png",
        byteSize: png.length,
        width: 1,
        height: 1,
        sha256: "b".repeat(64),
        profileVersion: "receipt-page-v1",
        renderer: "sharp/test",
      },
    });
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", jpeg, "second.jpg")
      .expect(409);
    const replaced = await request(app())
      .put(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", jpeg, "second.jpg")
      .expect(200);
    expect(replaced.body).toMatchObject({
      id: first.body.id,
      mediaType: "image/jpeg",
    });
    expect(await storage.exists(oldPath)).toBe(false);
    expect(await storage.exists(pagePath)).toBe(false);
    expect(await database.receiptPage.count()).toBe(0);
    await expect(
      database.normalizationJob.findUniqueOrThrow({
        where: { documentId: first.body.id },
      }),
    ).resolves.toMatchObject({ status: "pending" });
    expect(await database.documentFileCleanup.count()).toBe(0);
    await request(app())
      .delete(`/api/v1/receipts/${receiptId}/document`)
      .expect(204);
    expect(await database.receiptDocument.count()).toBe(0);
    await expect(
      database.receipt.delete({ where: { id: receiptId } }),
    ).resolves.toBeTruthy();
  });

  it("records failed old-file cleanup durably and retries it", async () => {
    const receiptId = await receipt();
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "first.png")
      .expect(201);
    const oldPath = (
      await database.receiptDocument.findUniqueOrThrow({ where: { receiptId } })
    ).relativePath;
    class OneFailureStorage extends FilesystemDocumentStorage {
      failed = false;
      override async cleanup(path: string): Promise<void> {
        if (path === oldPath && !this.failed) {
          this.failed = true;
          throw new Error("injected cleanup failure with /private/path");
        }
        await super.cleanup(path);
      }
    }
    const failingStorage = new OneFailureStorage(storage.root);
    storage = failingStorage;
    await request(app())
      .put(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", jpeg, "replacement.jpg")
      .expect(200);
    expect(await storage.exists(oldPath)).toBe(true);
    expect(
      await database.documentFileCleanup.findUnique({
        where: { relativePath: oldPath },
      }),
    ).toMatchObject({
      attempts: 1,
      lastError: "cleanup_failed",
    });
    await retryDocumentFileCleanup(database, storage);
    expect(await storage.exists(oldPath)).toBe(false);
    expect(await database.documentFileCleanup.count()).toBe(0);
  });

  it("serves only published pages and retries without discarding them", async () => {
    const receiptId = await receipt();
    const uploaded = await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "page.png")
      .expect(201);
    const relativePath = normalizedPageRevisionPath(
      uploaded.body.id,
      "test-revision",
      1,
    );
    const staged = await storage.stage(png, "worker");
    await storage.promote(staged, relativePath);
    const page = await database.receiptPage.create({
      data: {
        documentId: uploaded.body.id,
        pageNumber: 1,
        totalPages: 1,
        relativePath,
        mediaType: "image/png",
        byteSize: png.length,
        width: 1,
        height: 1,
        sha256: "a".repeat(64),
        profileVersion: "receipt-page-v1",
        renderer: "sharp/test",
      },
    });
    await database.$transaction([
      database.receiptDocument.update({
        where: { id: uploaded.body.id },
        data: {
          normalizationStatus: "complete",
          normalizationProfileVersion: "receipt-page-v1",
          normalizationRenderer: "sharp/test",
          normalizationCompletedAt: new Date(),
        },
      }),
      database.normalizationJob.update({
        where: { documentId: uploaded.body.id },
        data: { status: "complete" },
      }),
    ]);

    const fetched = await request(app())
      .get(`/api/v1/receipts/${receiptId}/document`)
      .expect(200);
    expect(fetched.body).toMatchObject({
      normalizationStatus: "complete",
      normalizationProfileVersion: "receipt-page-v1",
      pages: [
        {
          id: page.id,
          pageNumber: 1,
          totalPages: 1,
          profileVersion: "receipt-page-v1",
          renderer: "sharp/test",
        },
      ],
    });
    expect(fetched.body.pages[0]).not.toHaveProperty("relativePath");
    await request(app())
      .get(fetched.body.pages[0].imageUrl)
      .expect(200)
      .expect("Content-Type", "image/png")
      .expect("X-Content-Type-Options", "nosniff")
      .expect(png);

    const retried = await request(app())
      .post(`/api/v1/receipts/${receiptId}/document/normalization`)
      .expect(202);
    expect(retried.body).toMatchObject({
      normalizationStatus: "pending",
      normalizationError: null,
      pages: [{ id: page.id }],
    });
    await expect(
      database.normalizationJob.findUniqueOrThrow({
        where: { documentId: uploaded.body.id },
      }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("rejects retry while normalization is pending or running", async () => {
    const receiptId = await receipt();
    const uploaded = await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "queued.png")
      .expect(201);
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document/normalization`)
      .expect(409, {
        error: {
          code: "conflict",
          message: "Document normalization is already queued",
        },
      });
    await database.$transaction([
      database.normalizationJob.update({
        where: { documentId: uploaded.body.id },
        data: {
          status: "running",
          claimedAt: new Date(),
          claimToken: "active-claim",
        },
      }),
      database.receiptDocument.update({
        where: { id: uploaded.body.id },
        data: { normalizationStatus: "running" },
      }),
    ]);
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document/normalization`)
      .expect(409);
    await expect(
      database.normalizationJob.findUniqueOrThrow({
        where: { documentId: uploaded.body.id },
      }),
    ).resolves.toMatchObject({
      status: "running",
      claimToken: "active-claim",
    });
  });

  it("rejects missing, malformed multipart, and mismatched IDs safely", async () => {
    const receiptId = await receipt();
    await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .send("not multipart")
      .expect(400);
    const uploaded = await request(app())
      .post(`/api/v1/receipts/${receiptId}/document`)
      .attach("document", png, "safe.png")
      .expect(201);
    const otherReceipt = await receipt();
    await request(app())
      .get(
        `/api/v1/receipts/${otherReceipt}/documents/${uploaded.body.id}/original`,
      )
      .expect(404);
    await request(app())
      .get(`/api/v1/receipts/${otherReceipt}/document`)
      .expect(404);
  });
});
