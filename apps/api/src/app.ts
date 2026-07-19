import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import {
  apiErrorSchema,
  healthResponseSchema,
  receiptCreateSchema,
  receiptIdSchema,
  receiptListQuerySchema,
  receiptUpdateSchema,
} from "@receipt-report/contracts";
import type { Database } from "@receipt-report/database";
import { ZodError } from "zod";
import {
  InvalidCursorError,
  ReceiptNotFoundError,
  ReceiptRepository,
} from "./receipts.js";

export type AppOptions = {
  webDistDirectory?: string;
  database?: Database;
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/v1/health", (_request, response) => {
    response.json(
      healthResponseSchema.parse({
        status: "ok",
        service: "receipt-report-api",
        version: "v1",
      }),
    );
  });

  if (options.database) {
    const receipts = new ReceiptRepository(options.database);
    app.get("/api/v1/receipts", async (request, response, next) => {
      try {
        const query = receiptListQuerySchema.parse(request.query);
        response.json(await receipts.list(query.limit, query.cursor));
      } catch (error) {
        next(error);
      }
    });
    app.post("/api/v1/receipts", async (request, response, next) => {
      try {
        response
          .status(201)
          .json(await receipts.create(receiptCreateSchema.parse(request.body)));
      } catch (error) {
        next(error);
      }
    });
    app.get("/api/v1/receipts/:id", async (request, response, next) => {
      try {
        response.json(
          await receipts.get(receiptIdSchema.parse(request.params.id)),
        );
      } catch (error) {
        next(error);
      }
    });
    app.patch("/api/v1/receipts/:id", async (request, response, next) => {
      try {
        response.json(
          await receipts.update(
            receiptIdSchema.parse(request.params.id),
            receiptUpdateSchema.parse(request.body),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    app.delete("/api/v1/receipts/:id", async (request, response, next) => {
      try {
        await receipts.delete(receiptIdSchema.parse(request.params.id));
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });
  }

  if (options.webDistDirectory) {
    const webDistDirectory = resolve(options.webDistDirectory);
    if (existsSync(webDistDirectory)) {
      const indexHtml = readFileSync(
        resolve(webDistDirectory, "index.html"),
        "utf8",
      );
      app.use(express.static(webDistDirectory));
      app.get("/{*path}", (_request, response) =>
        response.type("html").send(indexHtml),
      );
    }
  }

  app.use((_request, response) =>
    response.status(404).json(apiError("not_found", "Route not found")),
  );
  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    void _next;
    if (error instanceof ZodError || error instanceof SyntaxError) {
      response
        .status(400)
        .json(apiError("validation_error", "Request validation failed"));
      return;
    }
    if (error instanceof InvalidCursorError) {
      response
        .status(400)
        .json(apiError("invalid_cursor", "Invalid pagination cursor"));
      return;
    }
    if (error instanceof ReceiptNotFoundError) {
      response.status(404).json(apiError("not_found", "Receipt not found"));
      return;
    }
    if (error instanceof PrismaClientKnownRequestError) {
      console.error("Receipt database operation failed", error.code);
    } else {
      console.error("Unexpected API error");
    }
    response
      .status(500)
      .json(apiError("internal_error", "Unexpected server error"));
  };
  app.use(errorHandler);
  return app;
}

function apiError(
  code: "validation_error" | "invalid_cursor" | "not_found" | "internal_error",
  message: string,
) {
  return apiErrorSchema.parse({ error: { code, message } });
}
