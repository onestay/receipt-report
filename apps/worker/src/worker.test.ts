import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const worker = await startWorker({
      DATABASE_URL: `file:${join(directory, "worker.db")}`,
      STORAGE_PATH: join(directory, "storage"),
      WORKER_READY_FILE: readyFile,
    });
    expect(await readFile(readyFile, "utf8")).toMatch(/^\d+\n$/);
    await worker.stop();
    await worker.stop();
    await expect(access(readyFile)).rejects.toThrow();
  });
});
