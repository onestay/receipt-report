import { startWorker } from "./worker.js";

void startWorker()
  .then(({ stop }) => {
    const shutdown = async (signal: string) => {
      console.log(`receipt-report-worker received ${signal}`);
      await stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
