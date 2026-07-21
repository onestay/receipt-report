import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig, type WorkerConfig } from "@receipt-report/config";
import {
  createDatabase,
  FilesystemDocumentStorage,
  originalDocumentPath,
  type Database,
} from "@receipt-report/database";
import { NormalizationProcessor } from "./normalization.js";
import { RendererFailure, type DocumentRenderer } from "./renderer.js";

let directory = "";
let database: Database;
let storage: FilesystemDocumentStorage;
let config: WorkerConfig;

function page(value: number, width = 2, height = 3) {
  const bytes = Buffer.from([value]);
  return {
    bytes,
    width,
    height,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "normalization-worker-"));
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
  config = parseWorkerConfig({
    DATABASE_URL: databaseUrl,
    STORAGE_PATH: storage.root,
    WORKER_READY_FILE: join(directory, "ready"),
    NORMALIZATION_VERIFY_RENDERER: "false",
    DOCUMENT_MAX_PDF_PAGES: "4",
    NORMALIZATION_MAX_PAGE_PIXELS: "100",
    NORMALIZATION_MAX_TOTAL_PIXELS: "200",
  });
});

afterEach(async () => {
  await database.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

async function seed() {
  const receipt = await database.receipt.create({
    data: {
      merchantRaw: "Synthetic",
      purchaseDate: "2026-07-21",
      totalCents: 1,
    },
  });
  const staged = await storage.stage(Buffer.from("original"));
  const target = originalDocumentPath(`seed_${receipt.id}`, "png");
  await storage.promote(staged, target);
  const document = await database.receiptDocument.create({
    data: {
      receiptId: receipt.id,
      relativePath: target,
      mediaType: "image/png",
      byteSize: 8,
      sha256: createHash("sha256").update("original").digest("hex"),
      normalizationJob: {
        create: { profileVersion: "receipt-page-v1" },
      },
    },
  });
  return { receipt, document, target };
}

async function retry(documentId: string) {
  await database.$transaction([
    database.normalizationJob.update({
      where: { documentId },
      data: {
        status: "pending",
        availableAt: new Date(),
        claimedAt: null,
      },
    }),
    database.receiptDocument.update({
      where: { id: documentId },
      data: { normalizationStatus: "pending" },
    }),
  ]);
}

describe("normalization processor", () => {
  it("publishes an ordered complete set and retries idempotently", async () => {
    const { document } = await seed();
    const renderer: DocumentRenderer = {
      render: vi.fn(async () => ({
        pages: [page(1), page(2)],
        renderer: "synthetic/1",
      })),
    };
    const processor = new NormalizationProcessor(
      database,
      storage,
      renderer,
      config,
    );
    await expect(processor.processNext()).resolves.toBe(true);
    const first = await database.receiptDocument.findUniqueOrThrow({
      where: { id: document.id },
      include: { pages: { orderBy: { pageNumber: "asc" } } },
    });
    expect(first).toMatchObject({
      normalizationStatus: "complete",
      normalizationProfileVersion: "receipt-page-v1",
      normalizationRenderer: "synthetic/1",
    });
    expect(first.pages.map((item) => item.pageNumber)).toEqual([1, 2]);
    expect(first.pages.every((item) => item.totalPages === 2)).toBe(true);
    for (const item of first.pages)
      expect(await storage.exists(item.relativePath)).toBe(true);

    const oldPaths = first.pages.map((item) => item.relativePath);
    await retry(document.id);
    await expect(processor.processNext()).resolves.toBe(true);
    expect(
      await database.receiptPage.count({ where: { documentId: document.id } }),
    ).toBe(2);
    expect(await database.documentFileCleanup.count()).toBe(0);
    for (const path of oldPaths) expect(await storage.exists(path)).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    await expect(processor.processNext()).resolves.toBe(false);
  });

  it("retains the last complete set when a retry fails", async () => {
    const { document, target } = await seed();
    let fail = false;
    const renderer: DocumentRenderer = {
      render: async () => {
        if (fail) throw new RendererFailure("renderer_crashed");
        return { pages: [page(1)], renderer: "synthetic/1" };
      },
    };
    const processor = new NormalizationProcessor(
      database,
      storage,
      renderer,
      config,
    );
    await processor.processNext();
    const completePage = await database.receiptPage.findFirstOrThrow({
      where: { documentId: document.id },
    });
    fail = true;
    await retry(document.id);
    await processor.processNext();
    expect(
      await database.receiptPage.findFirstOrThrow({
        where: { documentId: document.id },
      }),
    ).toMatchObject({
      id: completePage.id,
      relativePath: completePage.relativePath,
    });
    expect(
      await database.receiptDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ).toMatchObject({
      normalizationStatus: "failed",
      normalizationError: "renderer_crashed",
    });
    expect(await storage.exists(target)).toBe(true);
  });

  it("claims a pending job once across concurrent processors", async () => {
    await seed();
    const render = vi.fn(async () => ({
      pages: [page(1)],
      renderer: "fake/1",
    }));
    const first = new NormalizationProcessor(
      database,
      storage,
      { render },
      config,
    );
    const second = new NormalizationProcessor(
      database,
      storage,
      { render },
      config,
    );
    const results = await Promise.all([
      first.processNext(),
      second.processNext(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(1);
    expect(await database.receiptPage.count()).toBe(1);
  });

  it("cleans an old publication and preserves a newer retry state", async () => {
    const { document } = await seed();
    let release!: () => void;
    const rendering = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed!: () => void;
    const started = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const processor = new NormalizationProcessor(
      database,
      storage,
      {
        render: async () => {
          claimed();
          await rendering;
          return { pages: [page(9)], renderer: "old-claim/1" };
        },
      },
      config,
    );
    const processing = processor.processNext();
    await started;
    await retry(document.id);
    release();
    await processing;
    expect(
      await database.normalizationJob.findUniqueOrThrow({
        where: { documentId: document.id },
      }),
    ).toMatchObject({ status: "pending", lastError: null });
    expect(
      await database.receiptDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ).toMatchObject({ normalizationStatus: "pending" });
    expect(await database.documentFileCleanup.count()).toBe(0);
  });

  it("rejects renderer output outside page and pixel limits", async () => {
    const { document } = await seed();
    const processor = new NormalizationProcessor(
      database,
      storage,
      {
        render: async () => ({ pages: [page(1, 11, 10)], renderer: "fake/1" }),
      },
      config,
    );
    await processor.processNext();
    expect(await database.receiptPage.count()).toBe(0);
    expect(
      await database.receiptDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ).toMatchObject({
      normalizationStatus: "failed",
      normalizationError: "page_pixel_limit",
    });
  });

  it.each([
    ["page_count_limit", []],
    ["page_pixel_limit", [page(1, 0, 2)]],
    ["document_pixel_limit", [page(1, 10, 8), page(2, 10, 8)]],
  ])("sanitizes %s output violations", async (code, pages) => {
    const { document } = await seed();
    const limitedConfig = {
      ...config,
      NORMALIZATION_MAX_TOTAL_PIXELS: 150,
    };
    const processor = new NormalizationProcessor(
      database,
      storage,
      { render: async () => ({ pages, renderer: "fake/1" }) },
      limitedConfig,
    );
    await processor.processNext();
    expect(
      await database.receiptDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ).toMatchObject({
      normalizationStatus: "failed",
      normalizationError: code,
    });
  });

  it("returns interrupted jobs to pending without changing pages", async () => {
    const { document } = await seed();
    await database.normalizationJob.update({
      where: { documentId: document.id },
      data: { status: "running", claimedAt: new Date() },
    });
    await database.receiptDocument.update({
      where: { id: document.id },
      data: { normalizationStatus: "running" },
    });
    const processor = new NormalizationProcessor(
      database,
      storage,
      { render: async () => Promise.reject(new Error("not called")) },
      config,
    );
    await processor.resetInterruptedJobs();
    expect(
      await database.normalizationJob.findUniqueOrThrow({
        where: { documentId: document.id },
      }),
    ).toMatchObject({
      status: "pending",
      claimedAt: null,
    });
    expect(
      await database.receiptDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ).toMatchObject({
      normalizationStatus: "pending",
      normalizationStartedAt: null,
    });
  });
});
