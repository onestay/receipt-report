import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseReceiptAiConfig,
  parseWorkerConfig,
} from "@receipt-report/config";
import {
  createDatabase,
  enableWal,
  FilesystemDocumentStorage,
  reportJournalMode,
  retryDocumentFileCleanup,
} from "@receipt-report/database";
import {
  createConfiguredReceiptExtractor,
  ReceiptExtractionError,
  type ReceiptExtractor,
} from "@receipt-report/receipt-ai";
import { ExtractionProcessor } from "./extraction.js";
import { NormalizationProcessor } from "./normalization.js";
import { LocalDocumentRenderer, type DocumentRenderer } from "./renderer.js";

export async function startWorker(
  environment: NodeJS.ProcessEnv = process.env,
  injectedRenderer?: DocumentRenderer,
  injectedExtractor?: ReceiptExtractor,
) {
  const config = {
    ...parseWorkerConfig(environment),
    ...parseReceiptAiConfig(environment),
  };
  if (config.EXTRACTION_LEASE_MS < config.EXTRACTION_TIMEOUT_MS + 60_000)
    throw new ReceiptExtractionError("configuration", false);
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
  const extractor =
    injectedExtractor ?? createConfiguredReceiptExtractor(config);
  const extractionProcessor = new ExtractionProcessor(
    database,
    storage,
    extractor,
    config,
  );
  await processor.resetInterruptedJobs();
  await extractionProcessor.resetExpiredClaims();
  await extractionProcessor.purgeExpiredRawPayloads();
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
      const normalized = await processor.processNext();
      const extracted = await extractionProcessor.processNext();
      const processed = normalized || extracted;
      if (!stopped)
        timer = setTimeout(
          schedulePoll,
          processed
            ? 0
            : Math.min(config.NORMALIZATION_POLL_MS, config.EXTRACTION_POLL_MS),
        );
    } catch {
      console.error("Normalization worker iteration failed");
      if (!stopped)
        timer = setTimeout(
          schedulePoll,
          Math.min(config.NORMALIZATION_POLL_MS, config.EXTRACTION_POLL_MS),
        );
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
  return {
    database,
    processor,
    extractionProcessor,
    readyFile: config.WORKER_READY_FILE,
    stop,
  };
}
