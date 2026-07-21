import { randomUUID } from "node:crypto";
import type { WorkerConfig } from "@receipt-report/config";
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
    private readonly config: WorkerConfig,
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
        if (reset.count === 1)
          await transaction.receiptDocument.update({
            where: { id: job.documentId },
            data: {
              normalizationStatus: "pending",
              normalizationError: null,
              normalizationStartedAt: null,
            },
          });
      }
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
    try {
      const rendered = await this.renderer.render(job.document);
      this.validateRenderedPages(rendered);
      await this.publish(job, rendered);
    } catch (error) {
      const code =
        error instanceof RendererFailure ? error.code : "normalization_failed";
      await this.fail(job, code);
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
    try {
      await this.storage.cleanup(relativePath);
      await this.database.documentFileCleanup.deleteMany({
        where: { relativePath },
      });
    } catch {
      await this.recordCleanup(relativePath);
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
        staged.push(await this.storage.stage(page.bytes, "worker"));
      await this.database.$transaction(async (transaction) => {
        for (const relativePath of targets)
          await transaction.documentFileCleanup.upsert({
            where: { relativePath },
            create: { relativePath },
            update: {},
          });
      });
      for (let index = 0; index < staged.length; index += 1)
        await this.storage.promote(staged[index] ?? "", targets[index] ?? "");

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
          },
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
