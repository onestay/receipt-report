import { startWorker } from "./worker.js";
import { createLogger, safeUnexpectedError } from "@receipt-report/logging";

const bootstrapLogger = createLogger({
  service: "receipt-report-worker",
  level: "info",
});

const worker = startWorker();
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  bootstrapLogger.info(
    { event: "worker.shutdown.signal", signal },
    "Shutdown signal received",
  );
  const { stop } = await worker;
  await stop();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void worker.catch((error: unknown) => {
  if (!shuttingDown) {
    bootstrapLogger.fatal(
      {
        event: "worker.startup.failed",
        stage: "startup",
        ...safeUnexpectedError(error),
      },
      "Worker startup failed",
    );
    process.exitCode = 1;
  }
});
