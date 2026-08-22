import type { Database } from "@receipt-report/database";
import { operatorStatusResponseSchema } from "@receipt-report/contracts";

const ACTIVE_NORMALIZATION = ["pending", "running"];
const ACTIVE_EXTRACTION = ["pending", "running", "retry_wait"];

export class OperatorStatusRepository {
  constructor(
    private readonly database: Database,
    private readonly staleAfterMs: number,
  ) {}

  async get(now = new Date()) {
    const staleBefore = new Date(now.getTime() - this.staleAfterMs);
    const [normalization, extraction, emailImport, emailHealth] =
      await Promise.all([
        this.database.normalizationJob.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        this.database.extractionJob.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        this.database.emailAttachmentImport.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        this.database.emailImporterHealth.findUnique({
          where: { id: "default" },
        }),
      ]);
    const [staleNormalization, staleExtraction] = await Promise.all([
      this.database.normalizationJob.count({
        where: {
          status: { in: ACTIVE_NORMALIZATION },
          updatedAt: { lt: staleBefore },
        },
      }),
      this.database.extractionJob.count({
        where: {
          status: { in: ACTIVE_EXTRACTION },
          updatedAt: { lt: staleBefore },
        },
      }),
    ]);
    const count = (rows: typeof normalization, status: string) =>
      rows.find((row) => row.status === status)?._count._all ?? 0;
    const normalizationCounts = {
      healthy: count(normalization, "complete"),
      queued: count(normalization, "pending"),
      running: count(normalization, "running"),
      retrying: 0,
      failed: count(normalization, "failed"),
      stale: staleNormalization,
    };
    const extractionCounts = {
      healthy: count(extraction, "succeeded"),
      queued: count(extraction, "pending"),
      running: count(extraction, "running"),
      retrying: count(extraction, "retry_wait"),
      failed: count(extraction, "failed"),
      stale: staleExtraction,
    };
    return operatorStatusResponseSchema.parse({
      status:
        normalizationCounts.failed +
          extractionCounts.failed +
          normalizationCounts.stale +
          extractionCounts.stale >
        0
          ? "attention_required"
          : "healthy",
      checkedAt: now.toISOString(),
      staleAfterSeconds: Math.floor(this.staleAfterMs / 1000),
      normalization: normalizationCounts,
      extraction: extractionCounts,
      emailImport: {
        enabled: emailHealth?.enabled ?? false,
        lastSuccessfulPollAt:
          emailHealth?.lastSuccessfulPollAt?.toISOString() ?? null,
        pending: emailImport
          .filter((row) =>
            ["pending", "running", "retry_wait"].includes(row.status),
          )
          .reduce((sum, row) => sum + row._count._all, 0),
        imported:
          emailImport.find((row) => row.status === "imported")?._count._all ??
          0,
        duplicate:
          emailImport.find((row) => row.status === "duplicate")?._count._all ??
          0,
        failed:
          emailImport.find((row) => row.status === "failed")?._count._all ?? 0,
      },
    });
  }
}
