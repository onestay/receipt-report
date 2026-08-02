import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { ApiConfig, ReceiptAiConfig } from "@receipt-report/config";
import {
  apiErrorSchema,
  categorySuggestionQuerySchema,
  categorySuggestionRuleCreateSchema,
  categorySuggestionRuleListQuerySchema,
  categorySuggestionRuleUpdateSchema,
  categoryCreateSchema,
  categoryListQuerySchema,
  categoryReorderSchema,
  categoryUpdateSchema,
  correctionQualityQuerySchema,
  documentUploadConfigurationSchema,
  healthResponseSchema,
  operatorStatusResponseSchema,
  idSchema,
  merchantBrandCreateSchema,
  merchantBrandUpdateSchema,
  merchantListQuerySchema,
  merchantStoreCreateSchema,
  merchantStoreListQuerySchema,
  merchantStoreUpdateSchema,
  receiptCreateSchema,
  receiptIdSchema,
  receiptListQuerySchema,
  receiptUpdateSchema,
  spendingReportQuerySchema,
  proposalApproveSchema,
  type ApiError,
} from "@receipt-report/contracts";
import type {
  Database,
  FilesystemDocumentStorage,
} from "@receipt-report/database";
import { ZodError } from "zod";
import {
  requestId,
  safeError,
  safeUnexpectedError,
  silentLogger,
  type Logger,
} from "@receipt-report/logging";
import {
  ConflictError,
  DocumentRequestError,
  DuplicateDocumentError,
  InvalidCursorError,
  InvalidReferenceError,
  NotFoundError,
  prismaErrorCode,
} from "./errors.js";
import { CategoryRepository } from "./categories.js";
import { CategorySuggestionRuleRepository } from "./category-suggestion-rules.js";
import { DocumentRepository } from "./documents.js";
import { ExtractionRepository } from "./extractions.js";
import { MerchantRepository } from "./merchants.js";
import { stageMultipartDocument } from "./multipart.js";
import { ReceiptRepository } from "./receipts.js";
import { ProposalRepository } from "./proposals.js";
import { ReportRepository } from "./reports.js";
import { OperatorStatusRepository } from "./operator-status.js";

export type AppOptions = {
  webDistDirectory?: string;
  database?: Database;
  documentStorage?: FilesystemDocumentStorage;
  documentConfig?: Pick<
    ApiConfig,
    | "DOCUMENT_MAX_BYTES"
    | "DOCUMENT_MAX_REQUEST_BYTES"
    | "DOCUMENT_MAX_PDF_PAGES"
    | "DOCUMENT_MAX_IMAGE_WIDTH"
    | "DOCUMENT_MAX_IMAGE_HEIGHT"
    | "DOCUMENT_MAX_DECODED_PIXELS"
    | "DOCUMENT_VALIDATION_TIMEOUT_MS"
  >;
  extractionConfig?: {
    maxAttempts: ApiConfig["EXTRACTION_MAX_ATTEMPTS"];
    profileVersion: ReceiptAiConfig["EXTRACTION_PROFILE_VERSION"];
  };
  operatorStaleAfterMs?: number;
  logger?: Logger;
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const logger = options.logger ?? silentLogger;

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    const selected = requestId(request.header("X-Request-ID"));
    response.locals.requestId = selected;
    response.setHeader("X-Request-ID", selected);
    const started = performance.now();
    response.once("finish", () => {
      const context = {
        event: "api.request.completed",
        request_id: selected,
        method: request.method,
        route:
          typeof request.route?.path === "string"
            ? request.route.path
            : "unmatched",
        status: response.statusCode,
        duration_ms: Math.round(performance.now() - started),
      };
      const quietSuccess =
        response.statusCode < 400 &&
        request.method === "GET" &&
        ["/api/v1/health", "/api/v1/operator/status"].includes(
          typeof request.route?.path === "string" ? request.route.path : "",
        );
      if (quietSuccess) logger.debug(context, "API request completed");
      else if (response.statusCode >= 500)
        logger.error(context, "API request failed");
      else logger.info(context, "API request completed");
    });
    next();
  });
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
    const operatorStatus = new OperatorStatusRepository(
      options.database,
      options.operatorStaleAfterMs ?? 15 * 60_000,
    );
    app.get("/api/v1/operator/status", async (_request, response, next) => {
      try {
        response.json(
          operatorStatusResponseSchema.parse(await operatorStatus.get()),
        );
      } catch (error) {
        next(error);
      }
    });
    const categories = new CategoryRepository(options.database);
    app.get("/api/v1/categories", async (request, response, next) => {
      try {
        const query = categoryListQuerySchema.parse(request.query);
        response.json(await categories.list(query.includeArchived));
      } catch (error) {
        next(error);
      }
    });
    app.post("/api/v1/categories", async (request, response, next) => {
      try {
        response
          .status(201)
          .json(
            await categories.create(categoryCreateSchema.parse(request.body)),
          );
      } catch (error) {
        next(error);
      }
    });
    app.put("/api/v1/categories/reorder", async (request, response, next) => {
      try {
        response.json(
          await categories.reorder(categoryReorderSchema.parse(request.body)),
        );
      } catch (error) {
        next(error);
      }
    });
    app.patch("/api/v1/categories/:id", async (request, response, next) => {
      try {
        response.json(
          await categories.update(
            idSchema.parse(request.params.id),
            categoryUpdateSchema.parse(request.body),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    app.post(
      "/api/v1/categories/:id/archive",
      async (request, response, next) => {
        try {
          response.json(
            await categories.archive(idSchema.parse(request.params.id)),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.post(
      "/api/v1/categories/:id/restore",
      async (request, response, next) => {
        try {
          response.json(
            await categories.restore(idSchema.parse(request.params.id)),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.delete("/api/v1/categories/:id", async (request, response, next) => {
      try {
        await categories.delete(idSchema.parse(request.params.id));
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    });

    const suggestionRules = new CategorySuggestionRuleRepository(
      options.database,
    );
    app.get(
      "/api/v1/category-suggestion-rules/suggestion",
      async (request, response, next) => {
        try {
          response.json(
            await suggestionRules.suggest(
              categorySuggestionQuerySchema.parse(request.query),
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.get(
      "/api/v1/category-suggestion-rules",
      async (request, response, next) => {
        try {
          response.json(
            await suggestionRules.list(
              categorySuggestionRuleListQuerySchema.parse(request.query),
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.post(
      "/api/v1/category-suggestion-rules",
      async (request, response, next) => {
        try {
          response
            .status(201)
            .json(
              await suggestionRules.create(
                categorySuggestionRuleCreateSchema.parse(request.body),
              ),
            );
        } catch (error) {
          next(error);
        }
      },
    );
    app.get(
      "/api/v1/category-suggestion-rules/:id",
      async (request, response, next) => {
        try {
          response.json(
            await suggestionRules.get(idSchema.parse(request.params.id)),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.patch(
      "/api/v1/category-suggestion-rules/:id",
      async (request, response, next) => {
        try {
          response.json(
            await suggestionRules.update(
              idSchema.parse(request.params.id),
              categorySuggestionRuleUpdateSchema.parse(request.body),
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.delete(
      "/api/v1/category-suggestion-rules/:id",
      async (request, response, next) => {
        try {
          await suggestionRules.delete(idSchema.parse(request.params.id));
          response.status(204).end();
        } catch (error) {
          next(error);
        }
      },
    );

    const merchants = new MerchantRepository(options.database);
    app.get("/api/v1/merchant-brands", async (request, response, next) => {
      try {
        response.json(
          await merchants.listBrands(
            merchantListQuerySchema.parse(request.query),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    app.post("/api/v1/merchant-brands", async (request, response, next) => {
      try {
        response
          .status(201)
          .json(
            await merchants.createBrand(
              merchantBrandCreateSchema.parse(request.body),
            ),
          );
      } catch (error) {
        next(error);
      }
    });
    app.get("/api/v1/merchant-brands/:id", async (request, response, next) => {
      try {
        response.json(
          await merchants.getBrand(idSchema.parse(request.params.id)),
        );
      } catch (error) {
        next(error);
      }
    });
    app.patch(
      "/api/v1/merchant-brands/:id",
      async (request, response, next) => {
        try {
          response.json(
            await merchants.updateBrand(
              idSchema.parse(request.params.id),
              merchantBrandUpdateSchema.parse(request.body),
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.delete(
      "/api/v1/merchant-brands/:id",
      async (request, response, next) => {
        try {
          await merchants.deleteBrand(idSchema.parse(request.params.id));
          response.status(204).end();
        } catch (error) {
          next(error);
        }
      },
    );

    app.get("/api/v1/merchant-stores", async (request, response, next) => {
      try {
        response.json(
          await merchants.listStores(
            merchantStoreListQuerySchema.parse(request.query),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    app.post("/api/v1/merchant-stores", async (request, response, next) => {
      try {
        response
          .status(201)
          .json(
            await merchants.createStore(
              merchantStoreCreateSchema.parse(request.body),
            ),
          );
      } catch (error) {
        next(error);
      }
    });
    app.get("/api/v1/merchant-stores/:id", async (request, response, next) => {
      try {
        response.json(
          await merchants.getStore(idSchema.parse(request.params.id)),
        );
      } catch (error) {
        next(error);
      }
    });
    app.patch(
      "/api/v1/merchant-stores/:id",
      async (request, response, next) => {
        try {
          response.json(
            await merchants.updateStore(
              idSchema.parse(request.params.id),
              merchantStoreUpdateSchema.parse(request.body),
            ),
          );
        } catch (error) {
          next(error);
        }
      },
    );
    app.delete(
      "/api/v1/merchant-stores/:id",
      async (request, response, next) => {
        try {
          await merchants.deleteStore(idSchema.parse(request.params.id));
          response.status(204).end();
        } catch (error) {
          next(error);
        }
      },
    );

    const receipts = new ReceiptRepository(options.database);
    const reports = new ReportRepository(options.database);
    app.get("/api/v1/reports/spending", async (request, response, next) => {
      try {
        response.json(
          await reports.spending(
            spendingReportQuerySchema.parse(request.query),
          ),
        );
      } catch (error) {
        next(error);
      }
    });
    app.get("/api/v1/reports/workflow", async (_request, response, next) => {
      try {
        response.json(await reports.workflow());
      } catch (error) {
        next(error);
      }
    });
    app.get("/api/v1/receipts", async (request, response, next) => {
      try {
        const query = receiptListQuerySchema.parse(request.query);
        response.json(await receipts.list(query));
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

    if (options.extractionConfig) {
      const extractions = new ExtractionRepository(
        options.database,
        options.extractionConfig,
      );
      const proposals = new ProposalRepository(
        options.database,
        options.extractionConfig.maxAttempts,
      );
      app.get("/api/v1/extraction-quality", async (request, response, next) => {
        try {
          response.json(
            await proposals.quality(
              correctionQualityQuerySchema.parse(request.query),
            ),
          );
        } catch (error) {
          next(error);
        }
      });
      app.get(
        "/api/v1/receipts/:id/extraction-proposal",
        async (request, response, next) => {
          try {
            response.json(
              await proposals.current(receiptIdSchema.parse(request.params.id)),
            );
          } catch (error) {
            next(error);
          }
        },
      );
      app.get(
        "/api/v1/receipts/:id/extraction-proposals",
        async (request, response, next) => {
          try {
            response.json(
              await proposals.history(receiptIdSchema.parse(request.params.id)),
            );
          } catch (error) {
            next(error);
          }
        },
      );
      app.post(
        "/api/v1/receipts/:id/extraction-proposals/:proposalId/approve",
        async (request, response, next) => {
          try {
            response.json(
              await proposals.approve(
                receiptIdSchema.parse(request.params.id),
                idSchema.parse(request.params.proposalId),
                proposalApproveSchema.parse(request.body),
              ),
            );
          } catch (error) {
            next(error);
          }
        },
      );
      app.post(
        "/api/v1/receipts/:id/extraction-proposals/:proposalId/reject",
        async (request, response, next) => {
          try {
            response.json(
              await proposals.reject(
                receiptIdSchema.parse(request.params.id),
                idSchema.parse(request.params.proposalId),
              ),
            );
          } catch (error) {
            next(error);
          }
        },
      );
      app.post(
        "/api/v1/receipts/:id/extraction/reprocess",
        async (request, response, next) => {
          try {
            response
              .status(202)
              .json(
                await proposals.reprocess(
                  receiptIdSchema.parse(request.params.id),
                ),
              );
          } catch (error) {
            next(error);
          }
        },
      );
      app.get(
        "/api/v1/receipts/:id/document/extraction",
        async (request, response, next) => {
          try {
            response.json(
              await extractions.status(
                receiptIdSchema.parse(request.params.id),
              ),
            );
          } catch (error) {
            next(error);
          }
        },
      );
      app.post(
        "/api/v1/receipts/:id/document/extraction",
        async (request, response, next) => {
          try {
            response
              .status(202)
              .json(
                await extractions.enqueue(
                  receiptIdSchema.parse(request.params.id),
                ),
              );
          } catch (error) {
            next(error);
          }
        },
      );
      app.post(
        "/api/v1/receipts/:id/document/extraction/retry",
        async (request, response, next) => {
          try {
            response
              .status(202)
              .json(
                await extractions.retry(
                  receiptIdSchema.parse(request.params.id),
                ),
              );
          } catch (error) {
            next(error);
          }
        },
      );
    }

    if (options.documentStorage && options.documentConfig) {
      const storage = options.documentStorage;
      const config = options.documentConfig;
      const documents = new DocumentRepository(options.database, storage, {
        maxPdfPages: config.DOCUMENT_MAX_PDF_PAGES,
        maxImageWidth: config.DOCUMENT_MAX_IMAGE_WIDTH,
        maxImageHeight: config.DOCUMENT_MAX_IMAGE_HEIGHT,
        maxDecodedPixels: config.DOCUMENT_MAX_DECODED_PIXELS,
        timeoutMs: config.DOCUMENT_VALIDATION_TIMEOUT_MS,
      });
      app.get("/api/v1/document-upload-configuration", (_request, response) => {
        response.json(
          documentUploadConfigurationSchema.parse({
            maxBytes: config.DOCUMENT_MAX_BYTES,
            acceptedMediaTypes: ["image/jpeg", "image/png", "application/pdf"],
          }),
        );
      });
      const ingest =
        (replace: boolean) =>
        async (
          request: express.Request,
          response: express.Response,
          next: express.NextFunction,
        ) => {
          let staged:
            Awaited<ReturnType<typeof stageMultipartDocument>> | undefined;
          try {
            const receiptId = receiptIdSchema.parse(request.params.id);
            staged = await stageMultipartDocument(
              request,
              storage,
              {
                requestBytes: config.DOCUMENT_MAX_REQUEST_BYTES,
                fileBytes: config.DOCUMENT_MAX_BYTES,
              },
              (relativePath) => documents.discardStaged(relativePath),
            );
            const result = await documents.ingest(receiptId, staged, replace);
            response.status(replace ? 200 : 201).json(result);
          } catch (error) {
            next(error);
          } finally {
            if (staged) await documents.discardStaged(staged.relativePath);
          }
        };
      app.post("/api/v1/receipts/:id/document", ingest(false));
      app.put("/api/v1/receipts/:id/document", ingest(true));
      app.get(
        "/api/v1/receipts/:id/document",
        async (request, response, next) => {
          try {
            response.json(
              await documents.get(receiptIdSchema.parse(request.params.id)),
            );
          } catch (error) {
            next(error);
          }
        },
      );
      app.delete(
        "/api/v1/receipts/:id/document",
        async (request, response, next) => {
          try {
            await documents.remove(receiptIdSchema.parse(request.params.id));
            response.status(204).end();
          } catch (error) {
            next(error);
          }
        },
      );
      app.post(
        "/api/v1/receipts/:id/document/normalization",
        async (request, response, next) => {
          try {
            response
              .status(202)
              .json(
                await documents.retry(receiptIdSchema.parse(request.params.id)),
              );
          } catch (error) {
            next(error);
          }
        },
      );
      app.get(
        "/api/v1/receipts/:receiptId/documents/:documentId/original",
        async (request, response, next) => {
          try {
            const original = await documents.original(
              receiptIdSchema.parse(request.params.receiptId),
              idSchema.parse(request.params.documentId),
            );
            const asciiFilename = original.filename.replace(
              /[^A-Za-z0-9._-]/g,
              "_",
            );
            response.set({
              "Content-Type": original.mediaType,
              "Content-Length": String(original.byteSize),
              "Content-Disposition": `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(original.filename)}`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
            });
            original.stream.once("error", next);
            original.stream.pipe(response);
          } catch (error) {
            next(error);
          }
        },
      );
      app.get(
        "/api/v1/receipts/:receiptId/documents/:documentId/pages/:pageId",
        async (request, response, next) => {
          try {
            const page = await documents.page(
              receiptIdSchema.parse(request.params.receiptId),
              idSchema.parse(request.params.documentId),
              idSchema.parse(request.params.pageId),
            );
            response.set({
              "Content-Type": page.mediaType,
              "Content-Length": String(page.byteSize),
              "Content-Disposition": "inline",
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "private, no-store",
            });
            page.stream.once("error", next);
            page.stream.pipe(response);
          } catch (error) {
            next(error);
          }
        },
      );
    }
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
    request,
    response,
    _next,
  ) => {
    if (response.headersSent) {
      _next(error);
      return;
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      logger.warn(
        {
          event: "api.request.validation_failed",
          request_id: response.locals.requestId,
          validation_stage: "request",
          issue_count: error instanceof ZodError ? error.issues.length : 1,
          issues:
            error instanceof ZodError
              ? error.issues.map((issue) => ({
                  path: issue.path.join("."),
                  code: issue.code,
                }))
              : [{ path: "body", code: "invalid_json" }],
        },
        "Request validation failed",
      );
      response
        .status(400)
        .json(apiError("validation_error", "Request validation failed"));
      return;
    }
    if (error instanceof InvalidReferenceError) {
      response.status(400).json(apiError("validation_error", error.message));
      return;
    }
    if (error instanceof InvalidCursorError) {
      response
        .status(400)
        .json(apiError("invalid_cursor", "Invalid pagination cursor"));
      return;
    }
    if (error instanceof NotFoundError) {
      response.status(404).json(apiError("not_found", error.message));
      return;
    }
    if (error instanceof DocumentRequestError) {
      const status =
        error.code === "document_too_large"
          ? 413
          : error.code === "unsupported_document"
            ? 415
            : 400;
      response.status(status).json(apiError(error.code, error.message));
      return;
    }
    if (error instanceof DuplicateDocumentError) {
      response.status(409).json(
        apiError("duplicate_document", error.message, {
          receiptId: error.receiptId,
          documentId: error.documentId,
        }),
      );
      return;
    }
    if (error instanceof ConflictError) {
      response.status(409).json(apiError("conflict", error.message));
      return;
    }
    const databaseErrorCode = prismaErrorCode(error);
    if (databaseErrorCode) {
      logger.error(
        {
          event: "api.database.failed",
          request_id: response.locals.requestId,
          error_code: databaseErrorCode,
          operation: "request",
        },
        "Receipt database operation failed",
      );
    } else {
      logger.error(
        {
          event: "api.request.unexpected_error",
          request_id: response.locals.requestId,
          method: request.method,
          route:
            typeof request.route?.path === "string"
              ? request.route.path
              : "unmatched",
          ...safeError(error),
          ...safeUnexpectedError(error),
        },
        "Unexpected API error",
      );
    }
    response
      .status(500)
      .json(apiError("internal_error", "Unexpected server error"));
  };
  app.use(errorHandler);
  return app;
}

function apiError(
  code: ApiError["error"]["code"],
  message: string,
  details?: unknown,
) {
  return apiErrorSchema.parse({ error: { code, message, details } });
}
