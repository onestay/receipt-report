import { mkdir } from "node:fs/promises";
import { parseApiConfig } from "@receipt-report/config";
import {
  createDatabase,
  enableWal,
  FilesystemDocumentStorage,
  reportJournalMode,
} from "@receipt-report/database";
import { createApp } from "./app.js";
import { retryDocumentFileCleanup } from "./documents.js";

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = parseApiConfig(environment);
  await mkdir(config.STORAGE_PATH, { recursive: true });
  const database = await createDatabase(config.DATABASE_URL);
  const journalMode = await enableWal(database);
  reportJournalMode(journalMode);
  const documentStorage = new FilesystemDocumentStorage(config.STORAGE_PATH);
  await documentStorage.initialize();
  await retryDocumentFileCleanup(database, documentStorage);

  const app = createApp({
    database,
    documentStorage,
    documentConfig: config,
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
