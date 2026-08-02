import { randomUUID } from "node:crypto";
import type { ReceiptAiConfig, WorkerConfig } from "@receipt-report/config";
import { NORMALIZATION_PROFILE_VERSION } from "@receipt-report/contracts";
import {
  type Database,
  type FilesystemDocumentStorage,
  normalizedPageRevisionPath,
} from "@receipt-report/database";
import {
  type DocumentRenderer,
  RendererFailure,
  type RenderedDocument,
} from "./renderer.js";
import { safeError, silentLogger, type Logger } from "@receipt-report/logging";

type ClaimedJob = {
  id: string;
  documentId: string;
  attempts: number;
  claimToken: string;
  document: {
    relativePath: string;
    mediaType: string;
  };
};

export class NormalizationProcessor {
  constructor(
    private readonly database: Database,
    private readonly storage: FilesystemDocumentStorage,
    private readonly renderer: DocumentRenderer,
    private readonly config: WorkerConfig & ReceiptAiConfig,
    private readonly logger: Logger = silentLogger,
  ) {}

  async resetInterruptedJobs(): Promise<void> {
    const staleBefore = new Date(
      Date.now() - this.config.NORMALIZATION_TIMEOUT_MS - 60_000,
    );
    const interrupted = await this.database.normalizationJob.findMany({
      where: {
        status: "running",
        OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
      },
      select: { id: true, documentId: true, claimToken: true },
    });
    if (interrupted.length === 0) return;
    await this.database.$transaction(async (transaction) => {
      let recovered = 0;
      for (const job of interrupted) {
        const reset = await transaction.normalizationJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            claimToken: job.claimToken,
            OR: [{ claimedAt: null }, { claimedAt: { lte: staleBefore } }],
          },
          data: {
            status: "pending",
            claimedAt: null,
            claimToken: null,
            availableAt: new Date(),
            lastError: null,
          },
        });
        if (reset.count === 1) {
          recovered++;
          await transaction.receiptDocument.update({
            where: { id: job.documentId },
            data: {
              normalizationStatus: "pending",
              normalizationError: null,
              normalizationStartedAt: null,
            },
          });
        }
      }
      if (recovered > 0)
        this.logger.warn(
          { event: "normalization.recovery.completed", count: recovered },
          "Interrupted normalization jobs recovered",
        );
    });
  }

  private async claim(): Promise<ClaimedJob | null> {
    return this.database.$transaction(async (transaction) => {
      const candidate = await transaction.normalizationJob.findFirst({
        where: { status: "pending", availableAt: { lte: new Date() } },
        orderBy: [{ availableAt: "asc" }, { id: "asc" }],
        include: {
          document: { select: { relativePath: true, mediaType: true } },
        },
      });
      if (!candidate) return null;
      const claimToken = randomUUID();
      const claimed = await transaction.normalizationJob.updateMany({
        where: { id: candidate.id, status: "pending" },
        data: {
          status: "running",
          claimedAt: new Date(),
          claimToken,
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      if (claimed.count !== 1) return null;
      await transaction.receiptDocument.update({
        where: { id: candidate.documentId },
        data: {
          normalizationStatus: "running",
          normalizationError: null,
          normalizationStartedAt: new Date(),
          normalizationCompletedAt: null,
        },
      });
      return {
        ...candidate,
        attempts: candidate.attempts + 1,
        claimToken,
      };
    });
  }

  async processNext(): Promise<boolean> {
    await this.resetInterruptedJobs();
    const job = await this.claim();
    if (!job) return false;
    const started = performance.now();
    let failureOperation = "render";
    this.logger.info(
      {
        event: "normalization.job.claimed",
        job_id: job.id,
        document_id: job.documentId,
        attempt_number: job.attempts,
      },
      "Normalization job claimed",
    );
    try {
      this.logger.info(
        {
          event: "normalization.render.started",
          job_id: job.id,
          document_id: job.documentId,
        },
        "Document rendering started",
      );
      const rendered = await this.renderer.render(job.document);
      this.validateRenderedPages(rendered);
      this.logger.info(
        {
          event: "normalization.render.succeeded",
          job_id: job.id,
          document_id: job.documentId,
          renderer: rendered.renderer,
          page_count: rendered.pages.length,
          aggregate_bytes: rendered.pages.reduce(
            (sum, page) => sum + page.byteSize,
            0,
          ),
          aggregate_pixels: rendered.pages.reduce(
            (sum, page) => sum + page.width * page.height,
            0,
          ),
          duration_ms: Math.round(performance.now() - started),
        },
        "Document rendering succeeded",
      );
      failureOperation = "publish_database";
      await this.publish(job, rendered);
      this.logger.info(
        {
          event: "normalization.job.published",
          job_id: job.id,
          document_id: job.documentId,
          duration_ms: Math.round(performance.now() - started),
        },
        "Normalization published",
      );
    } catch (error) {
      const code =
        error instanceof RendererFailure ? error.code : "normalization_failed";
      await this.fail(job, code);
      this.logger.error(
        {
          event: "normalization.job.failed",
          job_id: job.id,
          document_id: job.documentId,
          failure_code: code,
          operation: failureOperation,
          ...safeError(error),
          duration_ms: Math.round(performance.now() - started),
        },
        "Normalization failed",
      );
    }
    return true;
  }

  private validateRenderedPages(rendered: RenderedDocument): void {
    if (
      rendered.pages.length < 1 ||
      rendered.pages.length > this.config.DOCUMENT_MAX_PDF_PAGES
    )
      throw new RendererFailure("page_count_limit");
    let totalPixels = 0;
    for (const page of rendered.pages) {
      const pixels = page.width * page.height;
      if (
        page.width < 1 ||
        page.height < 1 ||
        pixels > this.config.NORMALIZATION_MAX_PAGE_PIXELS
      )
        throw new RendererFailure("page_pixel_limit");
      totalPixels += pixels;
    }
    if (totalPixels > this.config.NORMALIZATION_MAX_TOTAL_PIXELS)
      throw new RendererFailure("document_pixel_limit");
  }

  private async recordCleanup(relativePath: string): Promise<void> {
    await this.database.documentFileCleanup.upsert({
      where: { relativePath },
      create: { relativePath, attempts: 1, lastError: "cleanup_failed" },
      update: { attempts: { increment: 1 }, lastError: "cleanup_failed" },
    });
  }

  private async cleanup(relativePath: string): Promise<void> {
    const started = performance.now();
    try {
      await this.storage.cleanup(relativePath);
      this.logSlowStorage("cleanup", undefined, started);
      await this.database.documentFileCleanup.deleteMany({
        where: { relativePath },
      });
    } catch (error) {
      this.logger.error(
        {
          event: "storage.operation.failed",
          operation: "cleanup",
          duration_ms: Math.round(performance.now() - started),
          ...safeError(error),
        },
        "Storage cleanup failed",
      );
      await this.recordCleanup(relativePath);
    }
  }

  private logSlowStorage(
    operation: "stage" | "promote" | "cleanup",
    job: ClaimedJob | undefined,
    started: number,
  ): void {
    const duration = Math.round(performance.now() - started);
    if (duration < this.config.LOG_SLOW_OPERATION_MS) return;
    this.logger.warn(
      {
        event: "storage.operation.slow",
        operation,
        ...(job ? { job_id: job.id, document_id: job.documentId } : {}),
        duration_ms: duration,
      },
      "Storage operation was slow",
    );
  }

  private async storageOperation<T>(
    operation: "stage" | "promote",
    job: ClaimedJob,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    try {
      const result = await run();
      this.logSlowStorage(operation, job, started);
      return result;
    } catch (error) {
      this.logger.error(
        {
          event: "storage.operation.failed",
          operation,
          job_id: job.id,
          document_id: job.documentId,
          duration_ms: Math.round(performance.now() - started),
          ...safeError(error),
        },
        "Storage operation failed",
      );
      throw error;
    }
  }

  private async publish(
    job: ClaimedJob,
    rendered: RenderedDocument,
  ): Promise<void> {
    const revision = `${NORMALIZATION_PROFILE_VERSION}-${job.id}-${job.attempts}`;
    const staged: string[] = [];
    const targets = rendered.pages.map((_, index) =>
      normalizedPageRevisionPath(job.documentId, revision, index + 1),
    );
    try {
      for (const page of rendered.pages)
        staged.push(
          await this.storageOperation("stage", job, () =>
            this.storage.stage(page.bytes, "worker"),
          ),
        );
      await this.database.$transaction(async (transaction) => {
        for (const relativePath of targets)
          await transaction.documentFileCleanup.upsert({
            where: { relativePath },
            create: { relativePath },
            update: {},
          });
      });
      for (let index = 0; index < staged.length; index += 1)
        await this.storageOperation("promote", job, () =>
          this.storage.promote(staged[index] ?? "", targets[index] ?? ""),
        );

      const oldPaths = await this.database.$transaction(async (transaction) => {
        const active = await transaction.normalizationJob.findFirst({
          where: {
            id: job.id,
            status: "running",
            claimToken: job.claimToken,
          },
          select: { id: true },
        });
        if (!active) throw new Error("normalization_claim_lost");
        const oldPages = await transaction.receiptPage.findMany({
          where: { documentId: job.documentId },
          select: { relativePath: true },
        });
        for (const oldPage of oldPages)
          await transaction.documentFileCleanup.upsert({
            where: { relativePath: oldPage.relativePath },
            create: { relativePath: oldPage.relativePath },
            update: {},
          });
        await transaction.receiptPage.deleteMany({
          where: { documentId: job.documentId },
        });
        await transaction.receiptPage.createMany({
          data: rendered.pages.map((page, index) => ({
            documentId: job.documentId,
            pageNumber: index + 1,
            totalPages: rendered.pages.length,
            relativePath: targets[index] ?? "",
            mediaType: "image/png",
            byteSize: page.byteSize,
            width: page.width,
            height: page.height,
            sha256: page.sha256,
            profileVersion: NORMALIZATION_PROFILE_VERSION,
            renderer: rendered.renderer,
          })),
        });
        await transaction.receiptDocument.update({
          where: { id: job.documentId },
          data: {
            normalizationStatus: "complete",
            normalizationError: null,
            normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
            normalizationRenderer: rendered.renderer,
            normalizationCompletedAt: new Date(),
            normalizationRevision: revision,
          },
        });
        await transaction.extractionJob.updateMany({
          where: {
            documentId: job.documentId,
            status: { in: ["pending", "running", "retry_wait"] },
            normalizationRevision: { not: revision },
          },
          data: {
            status: "cancelled",
            claimedAt: null,
            leaseExpiresAt: null,
            claimToken: null,
          },
        });
        await transaction.extractionJob.upsert({
          where: {
            documentId_normalizationRevision: {
              documentId: job.documentId,
              normalizationRevision: revision,
            },
          },
          create: {
            documentId: job.documentId,
            normalizationRevision: revision,
            normalizationProfileVersion: NORMALIZATION_PROFILE_VERSION,
            extractionProfileVersion: this.config.EXTRACTION_PROFILE_VERSION,
            maxAttempts: this.config.EXTRACTION_MAX_ATTEMPTS,
          },
          update: {},
        });
        const completed = await transaction.normalizationJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            claimToken: job.claimToken,
          },
          data: {
            status: "complete",
            claimedAt: null,
            claimToken: null,
            lastError: null,
          },
        });
        if (completed.count !== 1) throw new Error("normalization_claim_lost");
        await transaction.documentFileCleanup.deleteMany({
          where: { relativePath: { in: targets } },
        });
        return oldPages.map((page) => page.relativePath);
      });
      await Promise.all(oldPaths.map((path) => this.cleanup(path)));
    } catch (error) {
      await Promise.all(
        [...staged, ...targets].map((path) => this.cleanup(path)),
      );
      throw error;
    }
  }

  private async fail(job: ClaimedJob, code: string): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const failed = await transaction.normalizationJob.updateMany({
        where: {
          id: job.id,
          status: "running",
          claimToken: job.claimToken,
        },
        data: {
          status: "failed",
          claimedAt: null,
          claimToken: null,
          lastError: code,
        },
      });
      if (failed.count !== 1) return;
      await transaction.receiptDocument.update({
        where: { id: job.documentId },
        data: {
          normalizationStatus: "failed",
          normalizationError: code,
          normalizationCompletedAt: new Date(),
        },
      });
    });
  }
}
