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
    const [normalization, extraction] = await Promise.all([
      this.database.normalizationJob.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      this.database.extractionJob.groupBy({
        by: ["status"],
        _count: { _all: true },
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
    });
  }
}
