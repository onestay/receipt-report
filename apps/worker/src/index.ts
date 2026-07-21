import { startWorker } from "./worker.js";

const worker = startWorker();
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`receipt-report-worker received ${signal}`);
  const { stop } = await worker;
  await stop();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void worker.catch((error: unknown) => {
  if (!shuttingDown) {
    console.error(error);
    process.exitCode = 1;
  }
});
