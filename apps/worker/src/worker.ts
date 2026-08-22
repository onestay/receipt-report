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
import { EmailImporter } from "./email-import.js";
import {
  createLogger,
  safeUnexpectedError,
  type Logger,
} from "@receipt-report/logging";

export async function startWorker(
  environment: NodeJS.ProcessEnv = process.env,
  injectedRenderer?: DocumentRenderer,
  injectedExtractor?: ReceiptExtractor,
  injectedLogger?: Logger,
) {
  const config = {
    ...parseWorkerConfig(environment),
    ...parseReceiptAiConfig(environment),
  };
  const logger =
    injectedLogger ??
    createLogger({
      service: "receipt-report-worker",
      level: config.LOG_LEVEL,
    });
  logger.info({ event: "worker.startup.begin" }, "Worker startup beginning");
  if (config.LOG_SENSITIVE_PROVIDER_ERRORS)
    logger.warn(
      { event: "worker.sensitive_provider_logging.enabled" },
      "Sensitive provider error logging is enabled",
    );
  if (config.EXTRACTION_LEASE_MS < config.EXTRACTION_TIMEOUT_MS + 60_000)
    throw new ReceiptExtractionError("configuration", false);
  await mkdir(config.STORAGE_PATH, { recursive: true });
  await mkdir(dirname(config.WORKER_READY_FILE), { recursive: true });
  const database = await createDatabase(config.DATABASE_URL);
  const journalMode = await enableWal(database);
  reportJournalMode(journalMode, (message) =>
    logger.warn({ event: "worker.database.journal_warning" }, message),
  );
  logger.info(
    { event: "worker.database.connected", journal_mode: journalMode },
    "Database connected",
  );
  const storage = new FilesystemDocumentStorage(config.STORAGE_PATH);
  await storage.cleanupStaging("worker");
  await retryDocumentFileCleanup(database, storage);
  const renderer =
    injectedRenderer ??
    new LocalDocumentRenderer(storage, config, undefined, logger);
  if (config.NORMALIZATION_VERIFY_RENDERER) await renderer.verify?.();
  const processor = new NormalizationProcessor(
    database,
    storage,
    renderer,
    config,
    logger,
  );
  const extractor =
    injectedExtractor ?? createConfiguredReceiptExtractor(config, { logger });
  const extractionProcessor = new ExtractionProcessor(
    database,
    storage,
    extractor,
    config,
    undefined,
    undefined,
    logger,
  );
  const emailImporter = new EmailImporter(database, storage, config, logger);
  await database.emailImporterHealth.upsert({
    where: { id: "default" },
    create: { id: "default", enabled: config.EMAIL_IMPORT_ENABLED },
    update: { enabled: config.EMAIL_IMPORT_ENABLED },
  });
  await processor.resetInterruptedJobs();
  await extractionProcessor.resetExpiredClaims();
  await extractionProcessor.purgeExpiredRawPayloads();
  await writeFile(config.WORKER_READY_FILE, `${process.pid}\n`, {
    encoding: "utf8",
  });
  logger.info({ event: "worker.ready" }, "Worker ready");

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let activePoll: Promise<void> | undefined;
  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const normalized = await processor.processNext();
      const extracted = await extractionProcessor.processNext();
      const imported = emailImporter.due() ? await emailImporter.poll() : false;
      const processed = normalized || extracted || imported;
      if (!stopped)
        timer = setTimeout(
          schedulePoll,
          processed
            ? 0
            : Math.min(
                config.NORMALIZATION_POLL_MS,
                config.EXTRACTION_POLL_MS,
                config.EMAIL_IMPORT_ENABLED
                  ? config.EMAIL_IMPORT_POLL_MS
                  : Number.MAX_SAFE_INTEGER,
              ),
        );
    } catch (error) {
      logger.error(
        {
          event: "worker.poll.failed",
          ...safeUnexpectedError(error),
        },
        "Worker iteration failed",
      );
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
    logger.info({ event: "worker.shutdown.requested" }, "Shutdown requested");
    stopped = true;
    if (timer) clearTimeout(timer);
    await activePoll;
    await rm(config.WORKER_READY_FILE, { force: true });
    await database.$disconnect();
    logger.info({ event: "worker.shutdown.completed" }, "Shutdown completed");
  }
  return {
    database,
    processor,
    extractionProcessor,
    emailImporter,
    readyFile: config.WORKER_READY_FILE,
    stop,
  };
}
