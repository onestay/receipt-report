import { startServer } from "./server.js";
import { createLogger, safeUnexpectedError } from "@receipt-report/logging";

const bootstrapLogger = createLogger({
  service: "receipt-report-api",
  level: "info",
});

void startServer()
  .then(({ stop }) => {
    const shutdown = async (signal: string) => {
      bootstrapLogger.info(
        { event: "api.shutdown.signal", signal },
        "Shutdown signal received",
      );
      await stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  })
  .catch((error: unknown) => {
    bootstrapLogger.fatal(
      {
        event: "api.startup.failed",
        stage: "startup",
        ...safeUnexpectedError(error),
      },
      "API startup failed",
    );
    process.exitCode = 1;
  });
