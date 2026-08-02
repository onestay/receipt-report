import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseReceiptAiConfig,
  parseWorkerConfig,
  type ReceiptAiConfig,
  type WorkerConfig,
} from "@receipt-report/config";
import {
  createDatabase,
  FilesystemDocumentStorage,
  normalizedPageRevisionPath,
  type Database,
} from "@receipt-report/database";
import {
  createDeterministicFakeReceiptExtractor,
  receiptExtractionSchema,
  ReceiptExtractionError,
  type ProposalSnapshot,
  type ReceiptExtractor,
} from "@receipt-report/receipt-ai";
import { ExtractionProcessor } from "./extraction.js";
import type { Logger } from "@receipt-report/logging";

let directory = "";
let database: Database;
let storage: FilesystemDocumentStorage;
let config: WorkerConfig & ReceiptAiConfig;
let nowMs = Date.parse("2026-07-31T12:00:00.000Z");

beforeEach(async () => {
  nowMs = Date.parse("2026-07-31T12:00:00.000Z");
  directory = await mkdtemp(join(tmpdir(), "extraction-worker-"));
  const databaseUrl = `file:${join(directory, "test.db")}`;
  execFileSync(
    "pnpm",
    ["--filter", "@receipt-report/database", "db:migrate:deploy"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
  database = await createDatabase(databaseUrl);
  storage = new FilesystemDocumentStorage(join(directory, "documents"));
  const environment = {
    DATABASE_URL: databaseUrl,
    STORAGE_PATH: storage.root,
    WORKER_READY_FILE: join(directory, "ready"),
    NORMALIZATION_VERIFY_RENDERER: "false",
    EXTRACTION_TIMEOUT_MS: "50",
    EXTRACTION_LEASE_MS: "100",
    EXTRACTION_MAX_ATTEMPTS: "3",
    EXTRACTION_RETRY_BASE_MS: "100",
    EXTRACTION_RETRY_MAX_MS: "1000",
    EXTRACTION_RETRY_AFTER_MAX_MS: "200",
    EXTRACTION_RETRY_JITTER_PERCENT: "0",
    EXTRACTION_RAW_RETENTION_MS: "1000",
  };
  config = {
    ...parseWorkerConfig(environment),
    ...parseReceiptAiConfig(environment),
  };
});

afterEach(async () => {
  await database.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

async function seed(options: { revision?: string; createJob?: boolean } = {}) {
  const revision = options.revision ?? "revision-1";
  const receipt = await database.receipt.create({
    data: {
      merchantRaw: "Synthetic extraction",
      purchaseDate: "2026-07-31",
      totalCents: 1,
    },
  });
  const document = await database.receiptDocument.create({
    data: {
      receiptId: receipt.id,
      relativePath: `originals/${receipt.id}/original.png`,
      mediaType: "image/png",
      byteSize: 1,
      sha256: createHash("sha256").update(receipt.id).digest("hex"),
      normalizationStatus: "complete",
      normalizationProfileVersion: "receipt-page-v1",
      normalizationRenderer: "synthetic/1",
      normalizationRevision: revision,
      normalizationCompletedAt: new Date(nowMs),
    },
  });
  const pages = [];
  for (let index = 0; index < 2; index += 1) {
    const bytes = Buffer.from([index + 1]);
    const relativePath = normalizedPageRevisionPath(
      document.id,
      revision,
      index + 1,
    );
    const staged = await storage.stage(bytes, "worker");
    await storage.promote(staged, relativePath);
    pages.push(
      await database.receiptPage.create({
        data: {
          documentId: document.id,
          pageNumber: index + 1,
          totalPages: 2,
          relativePath,
          mediaType: "image/png",
          byteSize: bytes.length,
          width: 1,
          height: 1,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          profileVersion: "receipt-page-v1",
          renderer: "synthetic/1",
        },
      }),
    );
  }
  const job =
    options.createJob === false
      ? null
      : await database.extractionJob.create({
          data: {
            documentId: document.id,
            normalizationRevision: revision,
            normalizationProfileVersion: "receipt-page-v1",
            extractionProfileVersion: "de-receipt-v2",
            maxAttempts: config.EXTRACTION_MAX_ATTEMPTS,
            availableAt: new Date(nowMs),
          },
        });
  return { receipt, document, pages, job };
}

function processor(
  extractor: ReceiptExtractor,
  random = () => 0.5,
  logger?: Logger,
) {
  return new ExtractionProcessor(
    database,
    storage,
    extractor,
    config,
    () => new Date(nowMs),
    random,
    logger,
  );
}

function captureLogger() {
  const events: Record<string, unknown>[] = [];
  const write = (fields: Record<string, unknown>) => events.push(fields);
  const logger = {
    trace: write,
    debug: write,
    info: write,
    warn: write,
    error: write,
    fatal: write,
    child() {
      return this;
    },
  } as unknown as Logger;
  return { events, logger };
}

function requireJob<T>(job: T | null): T {
  if (!job) throw new Error("Missing fixture extraction job");
  return job;
}

describe("extraction processor", () => {
  it("reads ordered normalized pages and retains immutable attempt output", async () => {
    const { document, job } = await seed();
    const storedJob = requireJob(job);
    const extract = vi.fn(createDeterministicFakeReceiptExtractor().extract);
    const captured = captureLogger();
    await expect(
      processor(
        { name: "fake", extract },
        undefined,
        captured.logger,
      ).processNext(),
    ).resolves.toBe(true);
    expect(extract).toHaveBeenCalledWith({
      documentId: document.id,
      jobId: storedJob.id,
      attemptId: expect.any(String),
      categoryOptions: expect.any(Array),
      pages: [
        expect.objectContaining({ position: 0, bytes: new Uint8Array([1]) }),
        expect.objectContaining({ position: 1, bytes: new Uint8Array([2]) }),
      ],
    });
    await expect(
      database.extractionJob.findUniqueOrThrow({ where: { id: storedJob.id } }),
    ).resolves.toMatchObject({ status: "succeeded", attempts: 1 });
    const attempt = await database.extractionAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({
      attemptNumber: 1,
      provider: "fake",
      model: "deterministic-fake-v1",
      status: "succeeded",
      failureKind: null,
    });
    expect(attempt.rawProviderOutput).toContain("deterministic_fake_output");
    expect(JSON.parse(attempt.validatedOutput ?? "{}")).toMatchObject({
      schemaVersion: "receipt-extraction-v2",
    });
    expect(captured.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "extraction.attempt.started",
          job_id: storedJob.id,
          document_id: document.id,
        }),
        expect.objectContaining({
          event: "extraction.attempt.published",
          job_id: storedJob.id,
          document_id: document.id,
        }),
      ]),
    );
    expect(JSON.stringify(captured.events)).not.toContain(
      "Synthetic extraction",
    );
    const proposal = await database.extractionProposal.findFirstOrThrow({
      include: { findings: true },
    });
    expect(JSON.parse(proposal.snapshot)).toMatchObject({
      merchantRaw: "",
      lineItems: [],
    });
    expect(proposal.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "required_merchant",
          severity: "blocking",
        }),
      ]),
    );
    expect(
      await database.receipt.findUniqueOrThrow({
        where: {
          id: (
            await database.receiptDocument.findUniqueOrThrow({
              where: { id: document.id },
            })
          ).receiptId,
        },
      }),
    ).toMatchObject({ merchantRaw: "Synthetic extraction", totalCents: 1 });
  });

  it("prefills a valid model category only on the editable proposal", async () => {
    const { receipt, document } = await seed();
    const absent = { value: null, confidence: null } as const;
    await processor({
      name: "fake",
      async extract(request) {
        const option = request.categoryOptions?.find(
          (candidate) => !candidate.path.includes(" > "),
        );
        if (!option) throw new Error("Missing category fixture");
        const structured = receiptExtractionSchema.parse({
          schemaVersion: "receipt-extraction-v2",
          profileVersion: "de-receipt-v2",
          merchantText: { value: "Markt", confidence: 1 },
          purchaseDate: { value: "2026-07-31", confidence: 1 },
          purchaseTime: absent,
          currency: { value: "EUR", confidence: 1 },
          grossTotalCents: { value: 100, confidence: 1 },
          netTotalCents: absent,
          taxTotalCents: absent,
          taxBreakdowns: [],
          lineItems: [
            {
              position: 0,
              description: { value: "Unbekanntes Produkt", confidence: 1 },
              quantityMilli: absent,
              unit: absent,
              unitPriceCents: absent,
              lineTotalCents: { value: 100, confidence: 1 },
              categoryToken: { value: option.token, confidence: 0.5 },
            },
          ],
          warnings: [],
        });
        return {
          documentId: document.id,
          provider: "fake",
          model: "fake-v2",
          rawProviderOutput: JSON.stringify(structured),
          structured,
        };
      },
    }).processNext();

    const attempt = await database.extractionAttempt.findFirstOrThrow();
    const options = JSON.parse(attempt.categoryOptionSnapshot ?? "[]") as {
      categoryId: string;
      path: string;
    }[];
    expect(attempt.categoryOptionFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const proposal = await database.extractionProposal.findFirstOrThrow();
    expect(JSON.parse(proposal.snapshot)).toMatchObject({
      lineItems: [
        {
          categoryId: options.find((option) => !option.path.includes(" > "))
            ?.categoryId,
          categoryProvenance: "model",
          categoryConfidence: 0.5,
        },
      ],
    });
    await expect(
      database.extractionFinding.findFirstOrThrow({
        where: { code: "low_category_confidence" },
      }),
    ).resolves.toMatchObject({ severity: "info" });
    await expect(
      database.lineItem.count({ where: { receiptId: receipt.id } }),
    ).resolves.toBe(0);
  });

  it("omits oversized category context without failing extraction", async () => {
    await seed();
    await database.category.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        name: `Synthetic category ${index}`,
        normalizedName: `synthetic category ${index}`,
        position: 1000 + index,
      })),
    });
    await expect(
      processor(createDeterministicFakeReceiptExtractor()).processNext(),
    ).resolves.toBe(true);
    await expect(
      database.extractionAttempt.findFirstOrThrow(),
    ).resolves.toMatchObject({ categoryOptionSnapshot: "[]" });
    await expect(
      database.extractionFinding.findFirstOrThrow({
        where: { code: "model_category_context_omitted" },
      }),
    ).resolves.toMatchObject({ severity: "info" });
  });

  it("publishes provenance-bearing category suggestions with store precedence", async () => {
    const { receipt, document, job } = await seed();
    const storedJob = requireJob(job);
    const brand = await database.merchantBrand.create({
      data: { name: "Markt", normalizedName: "markt" },
    });
    const store = await database.merchantStore.create({
      data: {
        brandId: brand.id,
        name: "Filiale",
        normalizedName: "filiale",
        normalizedAddressKey: "",
      },
    });
    await database.receipt.update({
      where: { id: receipt.id },
      data: { merchantBrandId: brand.id, merchantStoreId: store.id },
    });
    const categories = await Promise.all(
      ["Global", "Brand", "Store"].map((name, position) =>
        database.category.create({
          data: {
            name,
            normalizedName: name.toLowerCase(),
            position: 100 + position,
          },
        }),
      ),
    );
    const [globalCategory, brandCategory, storeCategory] = categories;
    if (!globalCategory || !brandCategory || !storeCategory)
      throw new Error("Missing category fixture");
    await database.categorySuggestionRule.createMany({
      data: [
        {
          description: "Apfel",
          normalizedDescription: "apfel",
          scopeKind: "global",
          scopeSpecificity: 0,
          scopeIdentity: "global",
          categoryId: globalCategory.id,
        },
        {
          description: "Apfel",
          normalizedDescription: "apfel",
          scopeKind: "brand",
          scopeSpecificity: 1,
          scopeIdentity: brand.id,
          categoryId: brandCategory.id,
          brandId: brand.id,
        },
        {
          description: "Apfel",
          normalizedDescription: "apfel",
          scopeKind: "store",
          scopeSpecificity: 2,
          scopeIdentity: store.id,
          categoryId: storeCategory.id,
          brandId: brand.id,
          storeId: store.id,
        },
      ],
    });
    const oldAttempt = await database.extractionAttempt.create({
      data: {
        jobId: storedJob.id,
        attemptNumber: 1,
        provider: "fake",
        model: "old-fake-v1",
        extractionProfileVersion: "de-receipt-v2",
        status: "succeeded",
      },
    });
    const oldProposal = await database.extractionProposal.create({
      data: {
        receiptId: receipt.id,
        documentId: document.id,
        attemptId: oldAttempt.id,
        normalizationRevision: "revision-1",
        extractionProfileVersion: "de-receipt-v2",
        snapshot: "{}",
      },
    });
    await database.extractionJob.update({
      where: { id: storedJob.id },
      data: { attempts: 1 },
    });
    const absent = { value: null, confidence: null } as const;
    const structured = receiptExtractionSchema.parse({
      schemaVersion: "receipt-extraction-v2",
      profileVersion: "de-receipt-v2",
      merchantText: { value: "Markt", confidence: 0.9 },
      purchaseDate: { value: "2026-07-31", confidence: 0.9 },
      purchaseTime: absent,
      currency: { value: "EUR", confidence: 1 },
      grossTotalCents: { value: 100, confidence: 0.9 },
      netTotalCents: absent,
      taxTotalCents: absent,
      taxBreakdowns: [],
      lineItems: [
        {
          position: 0,
          description: { value: "  APFEL ", confidence: 0.9 },
          quantityMilli: absent,
          unit: absent,
          unitPriceCents: absent,
          lineTotalCents: { value: 100, confidence: 0.9 },
          categoryToken: { value: "c0", confidence: 1 },
        },
        {
          position: 1,
          description: { value: "BANANE", confidence: 0.9 },
          quantityMilli: absent,
          unit: absent,
          unitPriceCents: absent,
          lineTotalCents: { value: 0, confidence: 0.9 },
          categoryToken: { value: "invented", confidence: 1 },
        },
      ],
      warnings: [],
    });
    await processor({
      name: "fake",
      async extract() {
        return {
          documentId: document.id,
          provider: "fake",
          model: "fake-v1",
          rawProviderOutput: JSON.stringify(structured),
          structured,
        };
      },
    }).processNext();
    const proposal = await database.extractionProposal.findFirstOrThrow({
      where: { status: "pending", NOT: { id: oldProposal.id } },
      include: { findings: true },
    });
    const published = JSON.parse(proposal.snapshot) as ProposalSnapshot;
    expect(published).toMatchObject({
      merchantBrandId: brand.id,
      merchantStoreId: store.id,
    });
    expect(published.lineItems[0]).toMatchObject({
      categoryId: null,
      categorySuggestion: {
        categoryId: storeCategory.id,
        scopeKind: "store",
      },
      categoryProvenance: "exact_rule",
    });
    expect(proposal.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "category_suggestion" }),
        expect.objectContaining({ code: "model_category_invalid" }),
      ]),
    );
    await expect(
      database.extractionProposal.findUniqueOrThrow({
        where: { id: oldProposal.id },
      }),
    ).resolves.toMatchObject({ status: "superseded" });
  });

  it("allows only one live claim across concurrent processors", async () => {
    await seed();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delegate = createDeterministicFakeReceiptExtractor();
    const extract = vi.fn(async (request) => {
      started?.();
      await blocked;
      return delegate.extract(request);
    });
    const first = processor({ name: "fake", extract });
    const second = processor({ name: "fake", extract });
    const active = first.processNext();
    await startedPromise;
    await expect(second.processNext()).resolves.toBe(false);
    release?.();
    await expect(active).resolves.toBe(true);
    expect(extract).toHaveBeenCalledOnce();
    expect(await database.extractionAttempt.count()).toBe(1);
  });

  it.each([
    ["rate_limit", true, 999, "retry_wait", 200],
    ["timeout", true, undefined, "retry_wait", 100],
    ["provider_unavailable", true, undefined, "retry_wait", 100],
    ["configuration", false, undefined, "failed", 0],
    ["authentication", false, undefined, "failed", 0],
    ["payload_too_large", false, undefined, "failed", 0],
    ["malformed_response", false, undefined, "failed", 0],
  ] as const)(
    "maps %s retryability without hot-looping",
    async (kind, retryable, retryAfterMs, expectedStatus, delay) => {
      const { job } = await seed();
      const storedJob = requireJob(job);
      const failing: ReceiptExtractor = {
        name: "synthetic",
        async extract() {
          throw new ReceiptExtractionError(
            kind,
            retryable,
            retryAfterMs,
            kind === "malformed_response"
              ? "sensitive malformed output"
              : undefined,
          );
        },
      };
      await processor(failing).processNext();
      const stored = await database.extractionJob.findUniqueOrThrow({
        where: { id: storedJob.id },
      });
      expect(stored).toMatchObject({
        status: expectedStatus,
        attempts: 1,
        lastErrorKind: kind,
      });
      expect(stored.availableAt.getTime() - nowMs).toBe(delay);
      await expect(
        database.extractionAttempt.findFirstOrThrow(),
      ).resolves.toMatchObject({
        status: "failed",
        failureKind: kind,
        retryable,
        rawProviderOutput:
          kind === "malformed_response" ? "sensitive malformed output" : null,
      });
    },
  );

  it("exhausts the retry cap and applies bounded jitter", async () => {
    config.EXTRACTION_RETRY_JITTER_PERCENT = 20;
    const { job } = await seed();
    const storedJob = requireJob(job);
    const failing: ReceiptExtractor = {
      name: "synthetic",
      async extract() {
        throw new ReceiptExtractionError("timeout", true);
      },
    };
    const extractionProcessor = processor(failing, () => 1);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await extractionProcessor.processNext();
      const stored = await database.extractionJob.findUniqueOrThrow({
        where: { id: storedJob.id },
      });
      expect(stored.attempts).toBe(attempt);
      expect(stored.status).toBe(attempt < 3 ? "retry_wait" : "failed");
      if (attempt < 3) {
        const expectedDelay = 100 * 2 ** (attempt - 1) * 1.2;
        expect(stored.availableAt.getTime() - nowMs).toBe(expectedDelay);
        nowMs = stored.availableAt.getTime();
      }
    }
    expect(await database.extractionAttempt.count()).toBe(3);
  });

  it("recovers an expired lease and continues attempt numbering", async () => {
    const { job } = await seed();
    const storedJob = requireJob(job);
    await database.extractionJob.update({
      where: { id: storedJob.id },
      data: {
        status: "running",
        attempts: 1,
        claimedAt: new Date(nowMs - 1000),
        leaseExpiresAt: new Date(nowMs - 1),
        claimToken: "expired",
      },
    });
    await database.extractionAttempt.create({
      data: {
        jobId: storedJob.id,
        attemptNumber: 1,
        provider: "fake",
        model: "deterministic-fake-v1",
        extractionProfileVersion: "de-receipt-v2",
        startedAt: new Date(nowMs - 1000),
      },
    });
    await processor(createDeterministicFakeReceiptExtractor()).processNext();
    const attempts = await database.extractionAttempt.findMany({
      orderBy: { attemptNumber: "asc" },
    });
    expect(attempts).toMatchObject([
      {
        attemptNumber: 1,
        status: "failed",
        failureKind: "provider_unavailable",
      },
      { attemptNumber: 2, status: "succeeded" },
    ]);
  });

  it("purges expired raw payloads idempotently while retaining audit data", async () => {
    const { job } = await seed();
    const storedJob = requireJob(job);
    await database.extractionAttempt.create({
      data: {
        jobId: storedJob.id,
        attemptNumber: 1,
        provider: "fake",
        model: "fake-v1",
        extractionProfileVersion: "de-receipt-v2",
        status: "succeeded",
        completedAt: new Date(nowMs - 1001),
        durationMs: 10,
        rawProviderOutput: "sensitive raw payload",
        validatedOutput: '{"safe":true}',
      },
    });
    const extractionProcessor = processor(
      createDeterministicFakeReceiptExtractor(),
    );
    await expect(extractionProcessor.purgeExpiredRawPayloads()).resolves.toBe(
      1,
    );
    await expect(extractionProcessor.purgeExpiredRawPayloads()).resolves.toBe(
      0,
    );
    await expect(
      database.extractionAttempt.findFirstOrThrow(),
    ).resolves.toMatchObject({
      rawProviderOutput: null,
      validatedOutput: '{"safe":true}',
      status: "succeeded",
      rawPurgedAt: new Date(nowMs),
    });
  });

  it("fences publication when a newer normalization revision appears", async () => {
    const { document, job } = await seed();
    const storedJob = requireJob(job);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delegate = createDeterministicFakeReceiptExtractor();
    const extractionProcessor = processor({
      name: "fake",
      async extract(request) {
        started?.();
        await blocked;
        return delegate.extract(request);
      },
    });
    const active = extractionProcessor.processNext();
    await startedPromise;
    await database.receiptDocument.update({
      where: { id: document.id },
      data: { normalizationRevision: "revision-2" },
    });
    release?.();
    await active;
    await expect(
      database.extractionJob.findUniqueOrThrow({ where: { id: storedJob.id } }),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      database.extractionAttempt.findFirstOrThrow(),
    ).resolves.toMatchObject({
      status: "cancelled",
      rawProviderOutput: expect.stringContaining("deterministic_fake_output"),
    });
  });
});
