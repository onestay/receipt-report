import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseWorkerConfig } from "@receipt-report/config";
import {
  createDatabase,
  enableWal,
  FilesystemDocumentStorage,
  reportJournalMode,
  retryDocumentFileCleanup,
} from "@receipt-report/database";
import { NormalizationProcessor } from "./normalization.js";
import { LocalDocumentRenderer, type DocumentRenderer } from "./renderer.js";

export async function startWorker(
  environment: NodeJS.ProcessEnv = process.env,
  injectedRenderer?: DocumentRenderer,
) {
  const config = parseWorkerConfig(environment);
  await mkdir(config.STORAGE_PATH, { recursive: true });
  await mkdir(dirname(config.WORKER_READY_FILE), { recursive: true });
  const database = await createDatabase(config.DATABASE_URL);
  const journalMode = await enableWal(database);
  reportJournalMode(journalMode);
  const storage = new FilesystemDocumentStorage(config.STORAGE_PATH);
  await storage.cleanupStaging("worker");
  await retryDocumentFileCleanup(database, storage);
  const renderer =
    injectedRenderer ?? new LocalDocumentRenderer(storage, config);
  if (config.NORMALIZATION_VERIFY_RENDERER) await renderer.verify?.();
  const processor = new NormalizationProcessor(
    database,
    storage,
    renderer,
    config,
  );
  await processor.resetInterruptedJobs();
  await writeFile(config.WORKER_READY_FILE, `${process.pid}\n`, {
    encoding: "utf8",
  });
  console.log("receipt-report-worker ready");

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let activePoll: Promise<void> | undefined;
  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const processed = await processor.processNext();
      if (!stopped)
        timer = setTimeout(
          schedulePoll,
          processed ? 0 : config.NORMALIZATION_POLL_MS,
        );
    } catch {
      console.error("Normalization worker iteration failed");
      if (!stopped)
        timer = setTimeout(schedulePoll, config.NORMALIZATION_POLL_MS);
    }
  };
  const schedulePoll = () => {
    activePoll = poll();
  };
  timer = setTimeout(schedulePoll, 0);
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    await activePoll;
    await rm(config.WORKER_READY_FILE, { force: true });
    await database.$disconnect();
  }
  return { database, processor, readyFile: config.WORKER_READY_FILE, stop };
}
