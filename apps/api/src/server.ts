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

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = parseApiConfig(environment);
  const receiptAiConfig = parseReceiptAiProfileConfig(environment);
  await mkdir(config.STORAGE_PATH, { recursive: true });
  const database = await createDatabase(config.DATABASE_URL);
  const journalMode = await enableWal(database);
  reportJournalMode(journalMode);
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
  });
  const server = app.listen(config.PORT, config.HOST);
  await new Promise<void>((resolveListening, reject) => {
    server.once("listening", resolveListening);
    server.once("error", reject);
  });
  console.log(
    `receipt-report-api ready at http://${config.HOST}:${config.PORT}`,
  );

  async function stop() {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolveClose();
      });
    });
    await database.$disconnect();
  }
  return { app, database, server, stop };
}
