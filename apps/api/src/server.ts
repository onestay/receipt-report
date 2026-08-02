import { mkdir } from "node:fs/promises";
import {
  parseApiConfig,
  parseReceiptAiProfileConfig,
} from "@receipt-report/config";
import {
  createDatabase,
  enableWal,
  FilesystemDocumentStorage,
  reportJournalMode,
  retryDocumentFileCleanup,
} from "@receipt-report/database";
import { createApp } from "./app.js";
import { createLogger, type Logger } from "@receipt-report/logging";

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
  injectedLogger?: Logger,
) {
  const config = parseApiConfig(environment);
  const logger =
    injectedLogger ??
    createLogger({ service: "receipt-report-api", level: config.LOG_LEVEL });
  logger.info({ event: "api.startup.begin" }, "API startup beginning");
  const receiptAiConfig = parseReceiptAiProfileConfig(environment);
  await mkdir(config.STORAGE_PATH, { recursive: true });
  const database = await createDatabase(config.DATABASE_URL);
  const journalMode = await enableWal(database);
  reportJournalMode(journalMode, (message) =>
    logger.warn({ event: "api.database.journal_warning" }, message),
  );
  logger.info(
    { event: "api.database.connected", journal_mode: journalMode },
    "Database connected",
  );
  const documentStorage = new FilesystemDocumentStorage(config.STORAGE_PATH);
  await documentStorage.cleanupStaging();
  await retryDocumentFileCleanup(database, documentStorage);

  const app = createApp({
    database,
    documentStorage,
    documentConfig: config,
    extractionConfig: {
      maxAttempts: config.EXTRACTION_MAX_ATTEMPTS,
      profileVersion: receiptAiConfig.EXTRACTION_PROFILE_VERSION,
    },
    operatorStaleAfterMs: config.OPERATOR_STALE_AFTER_MS,
    ...(config.WEB_DIST_DIR ? { webDistDirectory: config.WEB_DIST_DIR } : {}),
    logger,
  });
  const server = app.listen(config.PORT, config.HOST);
  await new Promise<void>((resolveListening, reject) => {
    server.once("listening", resolveListening);
    server.once("error", reject);
  });
  logger.info(
    { event: "api.ready", host: config.HOST, port: config.PORT },
    "API listening",
  );

  async function stop() {
    logger.info({ event: "api.shutdown.requested" }, "Shutdown requested");
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolveClose();
      });
    });
    await database.$disconnect();
    logger.info({ event: "api.shutdown.completed" }, "Shutdown completed");
  }
  return { app, database, server, stop, logger };
}
