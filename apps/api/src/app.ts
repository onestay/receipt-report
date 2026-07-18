import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type Express } from "express";
import { healthResponseSchema } from "@receipt-report/contracts";

export type AppOptions = {
  webDistDirectory?: string;
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.get("/api/v1/health", (_request, response) => {
    response.json(
      healthResponseSchema.parse({
        status: "ok",
        service: "receipt-report-api",
        version: "v1",
      }),
    );
  });

  if (options.webDistDirectory) {
    const webDistDirectory = resolve(options.webDistDirectory);
    if (existsSync(webDistDirectory)) {
      app.use(express.static(webDistDirectory));
      app.get("/{*path}", (_request, response) =>
        response.sendFile(resolve(webDistDirectory, "index.html")),
      );
    }
  }

  app.use((_request, response) =>
    response.status(404).json({ error: "not_found" }),
  );
  return app;
}
