import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "./index.js";
import {
  FilesystemDocumentStorage,
  DocumentStorageLimitError,
  EmptyDocumentError,
  normalizedPagePath,
  originalDocumentPath,
  persistOriginalDocument,
  replacementOriginalDocumentPath,
} from "./storage.js";

let directory = "";
let database: Database | undefined;
let storage: FilesystemDocumentStorage;

function db(): Database {
  if (!database) throw new Error("Test database is not initialized");
  return database;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "receipt-storage-"));
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
  await database?.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

describe("filesystem document storage", () => {
  it("stages, atomically promotes, reads, and repeatedly cleans a file", async () => {
    const staged = await storage.stage(new TextEncoder().encode("synthetic"));
    const target = originalDocumentPath("doc_123", ".pdf");
    await storage.promote(staged, target);
    expect((await storage.read(target)).toString()).toBe("synthetic");
    expect(await storage.exists(staged)).toBe(false);
    await storage.cleanup(target);
    await storage.cleanup(target);
    expect(await storage.exists(target)).toBe(false);
  });

  it("sweeps crash-left staging files before accepting uploads", async () => {
    const staged = await storage.stage(new Uint8Array([1]));
    expect(await storage.exists(staged)).toBe(true);
    await storage.cleanupStaging();
    expect(await storage.exists(staged)).toBe(false);
    await expect(storage.stage(new Uint8Array([2]))).resolves.toMatch(
      /^staging\//,
    );
  });

  it("confines generated and caller-provided paths", async () => {
    expect(originalDocumentPath("doc_123", "jpg")).toBe(
      "originals/doc_123/original.jpg",
    );
    expect(normalizedPagePath("doc_123", 2)).toBe(
      "pages/doc_123/page-0002.png",
    );
    expect(() => originalDocumentPath("../escape", "pdf")).toThrow();
    expect(() => normalizedPagePath("doc", 0)).toThrow();
    await expect(storage.read("../escape")).rejects.toThrow("escapes root");
    await expect(storage.promote("originals/x", "safe.pdf")).rejects.toThrow(
      "staged",
    );
  });

  it("refuses to overwrite an existing durable target", async () => {
    const target = originalDocumentPath("doc_collision", "png");
    const first = await storage.stage(new Uint8Array([1]));
    const second = await storage.stage(new Uint8Array([2]));
    await storage.promote(first, target);
    await expect(storage.promote(second, target)).rejects.toThrow(
      "already exists",
    );
    expect([...(await storage.read(target))]).toEqual([1]);
  });

  it("streams bounded staging while hashing and supports bounded reads", async () => {
    const bytes = Buffer.from("synthetic-stream");
    const staged = await storage.stageStream(
      Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
      bytes.length,
    );
    expect(staged).toEqual({
      relativePath: expect.stringMatching(/^staging\//),
      byteSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(await storage.readHead(staged.relativePath, 4)).toEqual(
      Buffer.from("synt"),
    );
    expect(await storage.readAt(staged.relativePath, 4, 5)).toEqual(
      Buffer.from("hetic"),
    );
    const streamed: Buffer[] = [];
    for await (const chunk of storage.createReadStream(staged.relativePath, {
      highWaterMark: 3,
    }))
      streamed.push(Buffer.from(chunk));
    expect(Buffer.concat(streamed)).toEqual(bytes);
  });

  it("cleans empty and over-limit staged streams", async () => {
    await expect(
      storage.stageStream(Readable.from([]), 1),
    ).rejects.toBeInstanceOf(EmptyDocumentError);
    await expect(
      storage.stageStream(Readable.from([Buffer.from("too large")]), 2),
    ).rejects.toBeInstanceOf(DocumentStorageLimitError);
    await storage.initialize();
    expect(await readdir(join(storage.root, "staging"))).toEqual([]);
  });

  it("reports failed staging cleanup for durable retry", async () => {
    const cleanup = storage.cleanup.bind(storage);
    storage.cleanup = async () => Promise.reject(new Error("injected cleanup"));
    const recorded: string[] = [];
    await expect(
      storage.stageStream(Readable.from([]), 1, async (path) => {
        recorded.push(path);
      }),
    ).rejects.toBeInstanceOf(EmptyDocumentError);
    expect(recorded).toEqual([expect.stringMatching(/^staging\//)]);
    storage.cleanup = cleanup;
    await cleanup(recorded[0] ?? "missing");
  });

  it("builds safe revision paths", () => {
    expect(replacementOriginalDocumentPath("doc_1", ".JPG", "rev_2")).toBe(
      "originals/doc_1/original-rev_2.jpg",
    );
    expect(() =>
      replacementOriginalDocumentPath("doc_1", "jpg", "../escape"),
    ).toThrow("Invalid storage path segment");
    expect(() => originalDocumentPath("doc", "exe")).toThrow(
      "Unsupported document extension",
    );
  });
});

describe("document persistence coordinator", () => {
  it("publishes a file and metadata together", async () => {
    const receipt = await db().receipt.create({
      data: {
        merchantRaw: "Synthetic",
        purchaseDate: "2026-07-21",
        totalCents: 1,
      },
    });
    const staged = await storage.stage(new Uint8Array([1, 2, 3]));
    const document = await persistOriginalDocument(db(), storage, {
      receiptId: receipt.id,
      stagedRelativePath: staged,
      originalFilename: "synthetic.png",
      mediaType: "image/png",
      byteSize: 3,
      sha256: "a".repeat(64),
    });
    const stored = await db().receiptDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    const target = stored.relativePath;
    expect(await storage.exists(target)).toBe(true);
    expect(stored).toMatchObject({
      receiptId: receipt.id,
      relativePath: target,
    });
    expect(await db().documentFileCleanup.count()).toBe(0);
    await expect(
      db().receipt.delete({ where: { id: receipt.id } }),
    ).rejects.toThrow();
  });

  it("removes a promoted file when metadata persistence fails", async () => {
    const staged = await storage.stage(new Uint8Array([1]));
    const receipt = await db().receipt.create({
      data: {
        merchantRaw: "Synthetic",
        purchaseDate: "2026-07-21",
        totalCents: 1,
      },
    });
    await expect(
      persistOriginalDocument(
        db(),
        storage,
        {
          receiptId: receipt.id,
          stagedRelativePath: staged,
          originalFilename: null,
          mediaType: "application/pdf",
          byteSize: 1,
          sha256: "b".repeat(64),
        },
        { afterPromote: async () => Promise.reject(new Error("injected")) },
      ),
    ).rejects.toThrow();
    expect(
      await db().receiptDocument.findUnique({
        where: { receiptId: receipt.id },
      }),
    ).toBeNull();
    expect(await storage.exists(staged)).toBe(false);
  });

  it("reports retryable cleanup when compensating removal fails", async () => {
    const receipt = await db().receipt.create({
      data: {
        merchantRaw: "Synthetic",
        purchaseDate: "2026-07-21",
        totalCents: 1,
      },
    });
    const staged = await storage.stage(new Uint8Array([1]));
    const cleanup = storage.cleanup.bind(storage);
    storage.cleanup = async () => Promise.reject(new Error("injected cleanup"));
    const recorded: string[] = [];
    await expect(
      persistOriginalDocument(
        db(),
        storage,
        {
          receiptId: receipt.id,
          stagedRelativePath: staged,
          originalFilename: null,
          mediaType: "image/jpeg",
          byteSize: 1,
          sha256: "e".repeat(64),
        },
        {
          afterPromote: async () => Promise.reject(new Error("injected")),
          onCleanupFailure: async (path) => {
            recorded.push(path);
          },
        },
      ),
    ).rejects.toThrow("injected");
    expect(recorded).toEqual([expect.stringMatching(/original\.jpg$/)]);
    expect(
      await db().documentFileCleanup.findUnique({
        where: { relativePath: recorded[0] },
      }),
    ).toMatchObject({ relativePath: recorded[0] });
    storage.cleanup = cleanup;
    await cleanup(recorded[0] ?? "missing");
    await db().documentFileCleanup.deleteMany();
  });

  it("enforces ordered page uniqueness", async () => {
    const receipt = await db().receipt.create({
      data: {
        merchantRaw: "Synthetic",
        purchaseDate: "2026-07-21",
        totalCents: 1,
      },
    });
    const document = await db().receiptDocument.create({
      data: {
        receiptId: receipt.id,
        relativePath: "originals/x/original.pdf",
        mediaType: "application/pdf",
        byteSize: 1,
        sha256: "c".repeat(64),
      },
    });
    const page = {
      documentId: document.id,
      pageNumber: 1,
      totalPages: 1,
      relativePath: "pages/x/page-0001.png",
      mediaType: "image/png",
      byteSize: 1,
      width: 1,
      height: 1,
      sha256: "d".repeat(64),
    };
    await db().receiptPage.create({ data: page });
    await expect(
      db().receiptPage.create({
        data: { ...page, relativePath: "pages/x/duplicate.png" },
      }),
    ).rejects.toThrow();
  });
});
