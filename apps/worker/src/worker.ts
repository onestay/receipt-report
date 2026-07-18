import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseWorkerConfig } from "@receipt-report/config";
import {
  createDatabase,
  enableWal,
  reportJournalMode,
} from "@receipt-report/database";

export async function startWorker(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = parseWorkerConfig(environment);
  await mkdir(config.STORAGE_PATH, { recursive: true });
  await mkdir(dirname(config.WORKER_READY_FILE), { recursive: true });
  const database = await createDatabase(config.DATABASE_URL);
  const journalMode = await enableWal(database);
  reportJournalMode(journalMode);
  await writeFile(config.WORKER_READY_FILE, `${process.pid}\n`, {
    encoding: "utf8",
  });
  console.log("receipt-report-worker ready");

  let stopped = false;
  const idleTimer = setInterval(console.debug, 60_000);
  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(idleTimer);
    await rm(config.WORKER_READY_FILE, { force: true });
    await database.$disconnect();
  }
  return { database, readyFile: config.WORKER_READY_FILE, stop };
}
