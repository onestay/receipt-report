import { createHash, randomUUID } from "node:crypto";
import type { ReceiptAiConfig, WorkerConfig } from "@receipt-report/config";
import type {
  Database,
  FilesystemDocumentStorage,
} from "@receipt-report/database";
import { normalizeRuleDescription } from "@receipt-report/contracts";
import {
  extractionToProposal,
  validateProposal,
  ReceiptExtractionError,
  type ReceiptExtractionErrorKind,
  type ReceiptExtractor,
  type ProposalSnapshot,
  type ProposalFinding,
  type ExtractionCategoryOption,
} from "@receipt-report/receipt-ai";

type ExtractionProcessorConfig = WorkerConfig & ReceiptAiConfig;

type ClaimedExtractionJob = {
  id: string;
  documentId: string;
  normalizationRevision: string;
  normalizationProfileVersion: string;
  extractionProfileVersion: string;
  attempts: number;
  maxAttempts: number;
  claimToken: string;
  attemptId: string;
};

type Failure = {
  kind: ReceiptExtractionErrorKind;
  retryable: boolean;
  retryAfterMs?: number | undefined;
  rawProviderOutput?: string | undefined;
};

export class ExtractionProcessor {
  constructor(
    private readonly database: Database,
    private readonly storage: FilesystemDocumentStorage,
    private readonly extractor: ReceiptExtractor,
    private readonly config: ExtractionProcessorConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  private modelName(): string {
    return this.config.EXTRACTION_PROVIDER === "openai-compatible"
      ? (this.config.EXTRACTION_MODEL ?? "unconfigured")
      : "deterministic-fake-v1";
  }

  async resetExpiredClaims(): Promise<void> {
    const now = this.clock();
    const jobs = await this.database.extractionJob.findMany({
      where: {
        status: "running",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      select: {
        id: true,
        attempts: true,
        maxAttempts: true,
        claimToken: true,
        claimedAt: true,
      },
    });
    for (const job of jobs) {
      await this.database.$transaction(async (transaction) => {
        const nextStatus =
          job.attempts < job.maxAttempts ? "retry_wait" : "failed";
        const reset = await transaction.extractionJob.updateMany({
          where: {
            id: job.id,
            status: "running",
            claimToken: job.claimToken,
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
          data: {
            status: nextStatus,
            availableAt: now,
            claimedAt: null,
            leaseExpiresAt: null,
            claimToken: null,
            lastErrorKind: "provider_unavailable",
          },
        });
        if (reset.count !== 1) return;
        await transaction.extractionAttempt.updateMany({
          where: {
            jobId: job.id,
            attemptNumber: job.attempts,
            status: "running",
          },
          data: {
            status: "failed",
            failureKind: "provider_unavailable",
            retryable: true,
            completedAt: now,
            durationMs: Math.max(
              0,
              now.getTime() - (job.claimedAt?.getTime() ?? now.getTime()),
            ),
          },
        });
      });
    }
  }

  async purgeExpiredRawPayloads(): Promise<number> {
    const cutoff = new Date(
      this.clock().getTime() - this.config.EXTRACTION_RAW_RETENTION_MS,
    );
    const purged = await this.database.extractionAttempt.updateMany({
      where: {
        rawProviderOutput: { not: null },
        rawPurgedAt: null,
        completedAt: { lte: cutoff },
      },
      data: { rawProviderOutput: null, rawPurgedAt: this.clock() },
    });
    return purged.count;
  }

  private async claim(): Promise<ClaimedExtractionJob | null> {
    const now = this.clock();
    return this.database.$transaction(async (transaction) => {
      const candidate = await transaction.extractionJob.findFirst({
        where: {
          status: { in: ["pending", "retry_wait"] },
          availableAt: { lte: now },
        },
        orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      });
      if (!candidate) return null;
      const claimToken = randomUUID();
      const attemptNumber = candidate.attempts + 1;
      const claimed = await transaction.extractionJob.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["pending", "retry_wait"] },
          attempts: candidate.attempts,
        },
        data: {
          status: "running",
          attempts: { increment: 1 },
          claimedAt: now,
          leaseExpiresAt: new Date(
            now.getTime() + this.config.EXTRACTION_LEASE_MS,
          ),
          claimToken,
          lastErrorKind: null,
        },
      });
      if (claimed.count !== 1) return null;
      const attempt = await transaction.extractionAttempt.create({
        data: {
          jobId: candidate.id,
          attemptNumber,
          provider: this.extractor.name,
          model: this.modelName(),
          extractionProfileVersion: candidate.extractionProfileVersion,
          startedAt: now,
        },
      });
      return {
        id: candidate.id,
        documentId: candidate.documentId,
        normalizationRevision: candidate.normalizationRevision,
        normalizationProfileVersion: candidate.normalizationProfileVersion,
        extractionProfileVersion: candidate.extractionProfileVersion,
        attempts: attemptNumber,
        maxAttempts: candidate.maxAttempts,
        claimToken,
        attemptId: attempt.id,
      };
    });
  }

  async processNext(): Promise<boolean> {
    await this.resetExpiredClaims();
    await this.purgeExpiredRawPayloads();
    const job = await this.claim();
    if (!job) return false;
    const startedAt = this.clock();
    try {
      const document = await this.database.receiptDocument.findUnique({
        where: { id: job.documentId },
        include: { pages: { orderBy: { pageNumber: "asc" } } },
      });
      if (
        !document ||
        document.normalizationStatus !== "complete" ||
        document.normalizationRevision !== job.normalizationRevision ||
        document.normalizationProfileVersion !==
          job.normalizationProfileVersion ||
        document.pages.length < 1 ||
        document.pages.some(
          (page, index) =>
            page.pageNumber !== index + 1 ||
            page.totalPages !== document.pages.length ||
            page.profileVersion !== job.normalizationProfileVersion,
        )
      ) {
        await this.cancel(job, startedAt);
        return true;
      }
      const pages = await Promise.all(
        document.pages.map(async (page, index) => ({
          position: index,
          mediaType: page.mediaType as "image/png" | "image/jpeg",
          bytes: new Uint8Array(await this.storage.read(page.relativePath)),
        })),
      );
      const categoryContext = await this.categoryContext();
      await this.database.extractionAttempt.update({
        where: { id: job.attemptId },
        data: {
          categoryOptionSnapshot: JSON.stringify(categoryContext.options),
          categoryOptionFingerprint: categoryContext.fingerprint,
        },
      });
      const result = await this.extractor.extract({
        documentId: job.documentId,
        pages,
        categoryOptions: categoryContext.options,
      });
      await this.publish(job, result, startedAt, categoryContext.omitted);
    } catch (error) {
      const failure: Failure =
        error instanceof ReceiptExtractionError
          ? {
              kind: error.kind,
              retryable: error.retryable,
              retryAfterMs: error.retryAfterMs,
              rawProviderOutput: error.rawProviderOutput,
            }
          : { kind: "malformed_response", retryable: false };
      await this.fail(job, failure, startedAt);
    }
    return true;
  }

  private duration(startedAt: Date): number {
    return Math.max(0, this.clock().getTime() - startedAt.getTime());
  }

  private async publish(
    job: ClaimedExtractionJob,
    result: Awaited<ReturnType<ReceiptExtractor["extract"]>>,
    startedAt: Date,
    categoryContextOmitted: boolean,
  ): Promise<void> {
    const now = this.clock();
    const built = await this.buildProposal(
      job.documentId,
      result.structured,
      JSON.parse(
        (
          await this.database.extractionAttempt.findUniqueOrThrow({
            where: { id: job.attemptId },
            select: { categoryOptionSnapshot: true },
          })
        ).categoryOptionSnapshot ?? "[]",
      ) as ExtractionCategoryOption[],
    );
    const proposal = built.proposal;
    const findings = [
      ...validateProposal(proposal),
      ...built.findings,
      ...(categoryContextOmitted
        ? [
            {
              code: "model_category_context_omitted",
              severity: "info" as const,
              fieldPath: null,
              message:
                "Category context was omitted because it exceeded provider bounds",
            },
          ]
        : []),
    ];
    await this.database.$transaction(async (transaction) => {
      const currentDocument = await transaction.receiptDocument.findFirst({
        where: {
          id: job.documentId,
          normalizationStatus: "complete",
          normalizationRevision: job.normalizationRevision,
          normalizationProfileVersion: job.normalizationProfileVersion,
        },
        select: { id: true },
      });
      const active = await transaction.extractionJob.findFirst({
        where: {
          id: job.id,
          status: "running",
          claimToken: job.claimToken,
          normalizationRevision: job.normalizationRevision,
        },
        select: { id: true },
      });
      if (!currentDocument || !active) {
        await transaction.extractionAttempt.updateMany({
          where: { id: job.attemptId, status: "running" },
          data: {
            status: "cancelled",
            completedAt: now,
            durationMs: this.duration(startedAt),
            rawProviderOutput: result.rawProviderOutput,
            validatedOutput: JSON.stringify(result.structured),
          },
        });
        await transaction.extractionJob.updateMany({
          where: { id: job.id, status: "running", claimToken: job.claimToken },
          data: {
            status: "cancelled",
            claimedAt: null,
            leaseExpiresAt: null,
            claimToken: null,
          },
        });
        return;
      }
      await transaction.extractionAttempt.update({
        where: { id: job.attemptId },
        data: {
          provider: result.provider,
          model: result.model,
          status: "succeeded",
          completedAt: now,
          durationMs: this.duration(startedAt),
          rawProviderOutput: result.rawProviderOutput,
          validatedOutput: JSON.stringify(result.structured),
        },
      });
      await transaction.extractionProposal.updateMany({
        where: {
          documentId: job.documentId,
          status: "pending",
          NOT: { attemptId: job.attemptId },
        },
        data: { status: "superseded" },
      });
      await transaction.extractionProposal.create({
        data: {
          receiptId: (
            await transaction.receiptDocument.findUniqueOrThrow({
              where: { id: job.documentId },
              select: { receiptId: true },
            })
          ).receiptId,
          documentId: job.documentId,
          attemptId: job.attemptId,
          normalizationRevision: job.normalizationRevision,
          extractionProfileVersion: job.extractionProfileVersion,
          snapshot: JSON.stringify(proposal),
          findings: { create: findings },
        },
      });
      await transaction.extractionJob.update({
        where: { id: job.id },
        data: {
          status: "succeeded",
          claimedAt: null,
          leaseExpiresAt: null,
          claimToken: null,
          lastErrorKind: null,
        },
      });
    });
  }

  private async buildProposal(
    documentId: string,
    extraction: Parameters<typeof extractionToProposal>[0],
    categoryOptions: ExtractionCategoryOption[],
  ): Promise<{ proposal: ProposalSnapshot; findings: ProposalFinding[] }> {
    const snapshot = extractionToProposal(extraction);
    const findings: ProposalFinding[] = [];
    const optionByToken = new Map(
      categoryOptions.map((option) => [option.token, option]),
    );
    const document = await this.database.receiptDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: {
        receipt: { select: { merchantBrandId: true, merchantStoreId: true } },
      },
    });
    snapshot.merchantBrandId = document.receipt.merchantBrandId;
    snapshot.merchantStoreId = document.receipt.merchantStoreId;
    for (const [index, line] of snapshot.lineItems.entries()) {
      if (!line.description.trim()) continue;
      const rules = await this.database.categorySuggestionRule.findMany({
        where: {
          normalizedDescription: normalizeRuleDescription(line.description),
          OR: [
            ...(document.receipt.merchantStoreId
              ? [
                  {
                    scopeKind: "store",
                    storeId: document.receipt.merchantStoreId,
                  },
                ]
              : []),
            ...(document.receipt.merchantBrandId
              ? [
                  {
                    scopeKind: "brand",
                    brandId: document.receipt.merchantBrandId,
                  },
                ]
              : []),
            { scopeKind: "global" },
          ],
        },
        orderBy: [{ scopeSpecificity: "desc" }, { id: "asc" }],
        include: {
          category: {
            include: {
              parent: { select: { archivedAt: true } },
              _count: { select: { children: true } },
            },
          },
        },
      });
      const rule = rules.find(
        (candidate) =>
          candidate.category.archivedAt === null &&
          (candidate.category.parent?.archivedAt ?? null) === null &&
          candidate.category._count.children === 0,
      );
      if (rule) {
        line.categorySuggestion = {
          categoryId: rule.categoryId,
          ruleId: rule.id,
          scopeKind: rule.scopeKind as "global" | "brand" | "store",
        };
        line.categoryProvenance = "exact_rule";
        line.categoryConfidence = null;
        continue;
      }
      const token = extraction.lineItems[index]?.categoryToken?.value ?? null;
      if (token === null) continue;
      const option = optionByToken.get(token);
      const category = option
        ? await this.database.category.findUnique({
            where: { id: option.categoryId },
            include: {
              parent: { select: { archivedAt: true } },
              _count: { select: { children: true } },
            },
          })
        : null;
      if (
        !option ||
        !category ||
        category.archivedAt !== null ||
        (category.parent?.archivedAt ?? null) !== null ||
        category._count.children !== 0
      ) {
        line.categoryConfidence = null;
        findings.push({
          code: "model_category_invalid",
          severity: "info",
          fieldPath: `lineItems.${index}.categoryId`,
          message: "The model category was unavailable",
        });
        continue;
      }
      line.categoryId = option.categoryId;
      line.categoryProvenance = "model";
      line.categoryConfidence =
        extraction.lineItems[index]?.categoryToken?.confidence ?? null;
      if (line.categoryConfidence !== null && line.categoryConfidence < 0.7)
        findings.push({
          code: "low_category_confidence",
          severity: "info",
          fieldPath: `lineItems.${index}.categoryId`,
          message: "Provider category confidence is low",
        });
    }
    return { proposal: snapshot, findings };
  }

  private async categoryContext(): Promise<{
    options: ExtractionCategoryOption[];
    fingerprint: string;
    omitted: boolean;
  }> {
    const categories = await this.database.category.findMany({
      include: {
        parent: { select: { name: true, archivedAt: true } },
        _count: { select: { children: true } },
      },
    });
    const ordered = categories
      .filter((category) => category.parentId === null)
      .sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      )
      .flatMap((parent) => [
        parent,
        ...categories
          .filter((category) => category.parentId === parent.id)
          .sort(
            (left, right) =>
              left.position - right.position || left.id.localeCompare(right.id),
          ),
      ]);
    const options = ordered
      .filter(
        (category) =>
          category.archivedAt === null &&
          (category.parent?.archivedAt ?? null) === null &&
          category._count.children === 0,
      )
      .map((category, index) => ({
        token: `c${index}`,
        categoryId: category.id,
        path: category.parent
          ? `${category.parent.name} > ${category.name}`
          : category.name,
      }));
    const serialized = JSON.stringify(options);
    const omitted =
      options.length > 500 || Buffer.byteLength(serialized, "utf8") > 65_536;
    const bounded = omitted ? [] : options;
    return {
      options: bounded,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(bounded))
        .digest("hex"),
      omitted,
    };
  }

  private retryDelay(job: ClaimedExtractionJob, failure: Failure): number {
    const exponential = Math.min(
      this.config.EXTRACTION_RETRY_MAX_MS,
      this.config.EXTRACTION_RETRY_BASE_MS * 2 ** Math.max(0, job.attempts - 1),
    );
    const jitter = this.config.EXTRACTION_RETRY_JITTER_PERCENT / 100;
    const jittered = Math.max(
      0,
      Math.round(exponential * (1 + (this.random() * 2 - 1) * jitter)),
    );
    const retryAfter = Math.min(
      failure.retryAfterMs ?? 0,
      this.config.EXTRACTION_RETRY_AFTER_MAX_MS,
    );
    return Math.max(jittered, retryAfter);
  }

  private async fail(
    job: ClaimedExtractionJob,
    failure: Failure,
    startedAt: Date,
  ): Promise<void> {
    const now = this.clock();
    const shouldRetry = failure.retryable && job.attempts < job.maxAttempts;
    const availableAt = new Date(
      now.getTime() + (shouldRetry ? this.retryDelay(job, failure) : 0),
    );
    await this.database.$transaction(async (transaction) => {
      const active = await transaction.extractionJob.findFirst({
        where: { id: job.id, status: "running", claimToken: job.claimToken },
        include: { document: { select: { normalizationRevision: true } } },
      });
      if (!active) return;
      const stale =
        active.document.normalizationRevision !== job.normalizationRevision;
      await transaction.extractionAttempt.updateMany({
        where: { id: job.attemptId, status: "running" },
        data: {
          status: stale ? "cancelled" : "failed",
          failureKind: stale ? null : failure.kind,
          retryable: stale ? null : failure.retryable,
          ...(failure.rawProviderOutput === undefined
            ? {}
            : { rawProviderOutput: failure.rawProviderOutput }),
          completedAt: now,
          durationMs: this.duration(startedAt),
        },
      });
      await transaction.extractionJob.updateMany({
        where: { id: job.id, status: "running", claimToken: job.claimToken },
        data: {
          status: stale ? "cancelled" : shouldRetry ? "retry_wait" : "failed",
          availableAt,
          claimedAt: null,
          leaseExpiresAt: null,
          claimToken: null,
          lastErrorKind: stale ? null : failure.kind,
        },
      });
    });
  }

  private async cancel(
    job: ClaimedExtractionJob,
    startedAt: Date,
  ): Promise<void> {
    const now = this.clock();
    await this.database.$transaction([
      this.database.extractionAttempt.updateMany({
        where: { id: job.attemptId, status: "running" },
        data: {
          status: "cancelled",
          completedAt: now,
          durationMs: this.duration(startedAt),
        },
      }),
      this.database.extractionJob.updateMany({
        where: { id: job.id, status: "running", claimToken: job.claimToken },
        data: {
          status: "cancelled",
          claimedAt: null,
          leaseExpiresAt: null,
          claimToken: null,
        },
      }),
    ]);
  }
}
