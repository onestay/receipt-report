import { startServer } from "./server.js";

void startServer()
  .then(({ stop }) => {
    const shutdown = async (signal: string) => {
      console.log(`receipt-report-api received ${signal}`);
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
