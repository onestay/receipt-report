import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  FilesystemDocumentStorage,
  normalizedPageRevisionPath,
} from "@receipt-report/database";
import { startWorker } from "./worker.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("worker lifecycle", () => {
  it("creates readiness after initialization and cleans up idempotently", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-worker-unit-${process.pid}-`),
    );
    const readyFile = join(directory, "worker.ready");
    const databaseUrl = `file:${join(directory, "worker.db")}`;
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    const seedDatabase = await createDatabase(databaseUrl);
    const receipt = await seedDatabase.receipt.create({
      data: {
        merchantRaw: "Worker lifecycle",
        purchaseDate: "2026-07-21",
        totalCents: 1,
      },
    });
    const document = await seedDatabase.receiptDocument.create({
      data: {
        receiptId: receipt.id,
        relativePath: "originals/lifecycle.png",
        mediaType: "image/png",
        byteSize: 1,
        sha256: "c".repeat(64),
        normalizationJob: { create: { profileVersion: "receipt-page-v1" } },
      },
    });
    const storagePath = join(directory, "storage");
    const seedStorage = new FilesystemDocumentStorage(storagePath);
    const orphanedPath = normalizedPageRevisionPath(
      document.id,
      "crashed-attempt",
      1,
    );
    const stagedOrphan = await seedStorage.stage(Buffer.from([9]), "worker");
    await seedStorage.promote(stagedOrphan, orphanedPath);
    await seedDatabase.documentFileCleanup.create({
      data: { relativePath: orphanedPath },
    });
    await seedDatabase.$disconnect();
    const render = vi.fn(async () => ({
      pages: [
        {
          bytes: Buffer.from([1]),
          width: 1,
          height: 1,
          byteSize: 1,
          sha256: "d".repeat(64),
        },
      ],
      renderer: "lifecycle/1",
    }));
    const worker = await startWorker(
      {
        DATABASE_URL: databaseUrl,
        STORAGE_PATH: storagePath,
        WORKER_READY_FILE: readyFile,
        NORMALIZATION_VERIFY_RENDERER: "false",
        NORMALIZATION_POLL_MS: "1",
      },
      { render },
    );
    expect(await readFile(readyFile, "utf8")).toMatch(/^\d+\n$/);
    expect(await seedStorage.exists(orphanedPath)).toBe(false);
    expect(await worker.database.documentFileCleanup.count()).toBe(0);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const normalized =
        await worker.database.receiptDocument.findUniqueOrThrow({
          where: { id: document.id },
        });
      if (normalized.normalizationStatus === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(render).toHaveBeenCalledOnce();
    await expect(
      worker.database.receiptDocument.findUniqueOrThrow({
        where: { id: document.id },
      }),
    ).resolves.toMatchObject({ normalizationStatus: "complete" });
    await worker.stop();
    await worker.stop();
    await expect(access(readyFile)).rejects.toThrow();
  });
});
import { execFileSync } from "node:child_process";
