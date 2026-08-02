import type { Prisma } from "@prisma/client";
import {
  correctionQualitySummarySchema,
  extractionProposalHistorySchema,
  extractionProposalSchema,
  proposalSnapshotSchema,
  type ProposalApprove,
  type CorrectionQualityQuery,
} from "@receipt-report/contracts";
import type { Database } from "@receipt-report/database";
import {
  correctionComparisons,
  proposalDifferences,
  validateProposal,
  type ProposalSnapshot,
} from "@receipt-report/receipt-ai";
import {
  ConflictError,
  InvalidReferenceError,
  NotFoundError,
} from "./errors.js";

const include = {
  findings: {
    orderBy: [{ severity: "desc" }, { code: "asc" }],
  },
} satisfies Prisma.ExtractionProposalInclude;
type StoredProposal = Prisma.ExtractionProposalGetPayload<{
  include: typeof include;
}>;

function output(record: StoredProposal) {
  return extractionProposalSchema.parse({
    ...record,
    snapshot: proposalSnapshotSchema.parse(JSON.parse(record.snapshot)),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    findings: record.findings.map(({ code, severity, fieldPath, message }) => ({
      code,
      severity,
      fieldPath,
      message,
    })),
  });
}

export function categoryQualityOutcome(
  provenance: string | null,
  correctionKind: string,
  accepted: string | null,
):
  | "accepted_model"
  | "corrected_model"
  | "cleared_model"
  | "exact_rule"
  | "unassigned"
  | null {
  if (provenance === "model") {
    if (accepted === null) return "cleared_model";
    return correctionKind === "unchanged"
      ? "accepted_model"
      : "corrected_model";
  }
  if (provenance === "exact_rule" && accepted !== null) return "exact_rule";
  return accepted === null ? "unassigned" : null;
}

export class ProposalRepository {
  constructor(
    private readonly database: Database,
    private readonly maxAttempts: number,
  ) {}

  private async receipt(id: string) {
    const receipt = await this.database.receipt.findUnique({ where: { id } });
    if (!receipt) throw new NotFoundError("Receipt not found");
    return receipt;
  }

  async current(receiptId: string) {
    await this.receipt(receiptId);
    const proposal = await this.database.extractionProposal.findFirst({
      where: { receiptId, status: "pending" },
      orderBy: { createdAt: "desc" },
      include,
    });
    if (!proposal)
      throw new NotFoundError("Current extraction proposal not found");
    return output(proposal);
  }

  async history(receiptId: string) {
    await this.receipt(receiptId);
    const [proposals, decisions] = await Promise.all([
      this.database.extractionProposal.findMany({
        where: { receiptId },
        orderBy: { createdAt: "desc" },
        include,
      }),
      this.database.extractionDecision.findMany({
        where: { proposal: { receiptId } },
        orderBy: { decidedAt: "desc" },
      }),
    ]);
    return extractionProposalHistorySchema.parse({
      proposals: proposals.map(output),
      decisions: decisions.map((decision) => ({
        ...decision,
        proposalSnapshot: JSON.parse(decision.proposalSnapshot),
        acceptedSnapshot: decision.acceptedSnapshot
          ? JSON.parse(decision.acceptedSnapshot)
          : null,
        differences: decision.differences
          ? JSON.parse(decision.differences)
          : null,
        acknowledgedWarnings: decision.acknowledgedWarnings
          ? JSON.parse(decision.acknowledgedWarnings)
          : null,
        decidedAt: decision.decidedAt.toISOString(),
      })),
    });
  }

  private async validateReferences(
    transaction: Prisma.TransactionClient,
    snapshot: ProposalSnapshot,
  ) {
    if (snapshot.merchantStoreId && !snapshot.merchantBrandId)
      throw new InvalidReferenceError(
        "merchantBrandId is required for merchantStoreId",
      );
    if (snapshot.merchantBrandId) {
      if (
        !(await transaction.merchantBrand.findUnique({
          where: { id: snapshot.merchantBrandId },
        }))
      )
        throw new InvalidReferenceError("Unknown merchantBrandId");
    }
    if (snapshot.merchantStoreId) {
      const store = await transaction.merchantStore.findUnique({
        where: { id: snapshot.merchantStoreId },
        select: { brandId: true },
      });
      if (!store || store.brandId !== snapshot.merchantBrandId)
        throw new InvalidReferenceError("Invalid merchantStoreId");
    }
    const categoryIds = [
      ...new Set(
        snapshot.lineItems.flatMap((line) =>
          line.categoryId ? [line.categoryId] : [],
        ),
      ),
    ];
    const categories = await transaction.category.findMany({
      where: { id: { in: categoryIds } },
      include: { parent: true, _count: { select: { children: true } } },
    });
    if (
      categories.length !== categoryIds.length ||
      categories.some(
        (category) =>
          category.archivedAt !== null ||
          (category.parent !== null && category.parent.archivedAt !== null) ||
          category._count.children > 0,
      )
    )
      throw new InvalidReferenceError(
        "categoryId must reference an active leaf category",
      );
  }

  async approve(receiptId: string, proposalId: string, input: ProposalApprove) {
    const snapshot = proposalSnapshotSchema.parse(input.snapshot);
    const findings = validateProposal(snapshot);
    if (findings.some((finding) => finding.severity === "blocking"))
      throw new ConflictError("Proposal contains blocking findings");
    const warningCodes = [
      ...new Set(
        findings
          .filter((finding) => finding.severity === "warning")
          .map((finding) => finding.code),
      ),
    ];
    if (
      warningCodes.some(
        (code) => !input.acknowledgedWarningCodes.includes(code),
      )
    )
      throw new ConflictError("Proposal warnings must be acknowledged");

    return this.database.$transaction(async (transaction) => {
      const proposal = await transaction.extractionProposal.findFirst({
        where: { id: proposalId, receiptId },
        include: { document: true, attempt: true, decisions: true },
      });
      if (!proposal) throw new ConflictError("Proposal is stale or superseded");
      if (proposal.status === "approved") {
        const prior = proposal.decisions.find(
          (decision) => decision.kind === "approved",
        );
        if (
          prior?.acceptedSnapshot &&
          JSON.stringify(
            proposalSnapshotSchema.parse(JSON.parse(prior.acceptedSnapshot)),
          ) === JSON.stringify(snapshot)
        )
          return { status: "approved" as const };
        throw new ConflictError("Proposal is stale or superseded");
      }
      if (proposal.status !== "pending")
        throw new ConflictError("Proposal is stale or superseded");
      if (
        proposal.normalizationRevision !== input.normalizationRevision ||
        proposal.document.normalizationRevision !== input.normalizationRevision
      )
        throw new ConflictError("Document revision changed");
      const receipt = await transaction.receipt.findUnique({
        where: { id: receiptId },
      });
      if (!receipt) throw new NotFoundError("Receipt not found");
      if (receipt.updatedAt.toISOString() !== input.receiptUpdatedAt)
        throw new ConflictError("Receipt changed since review began");
      await this.validateReferences(transaction, snapshot);
      const original = proposalSnapshotSchema.parse(
        JSON.parse(proposal.snapshot),
      );
      const updated = await transaction.receipt.updateMany({
        where: { id: receiptId, updatedAt: receipt.updatedAt },
        data: {
          merchantRaw: snapshot.merchantRaw.trim(),
          merchantBrandId: snapshot.merchantBrandId,
          merchantStoreId: snapshot.merchantStoreId,
          purchaseDate: snapshot.purchaseDate,
          purchaseTime: snapshot.purchaseTime,
          currency: snapshot.currency,
          totalCents: snapshot.totalCents,
          netCents: snapshot.netCents,
          taxCents: snapshot.taxCents,
        },
      });
      if (updated.count !== 1)
        throw new ConflictError("Receipt changed during approval");
      await transaction.lineItem.deleteMany({ where: { receiptId } });
      await transaction.lineItem.createMany({
        data: snapshot.lineItems.map((line, position) => ({
          receiptId,
          description: line.description.trim(),
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          lineTotalCents: line.lineTotalCents,
          categoryId: line.categoryId,
          kind: line.kind,
          position,
        })),
      });
      const decision = await transaction.extractionDecision.create({
        data: {
          proposalId,
          kind: "approved",
          actor: "local-user",
          proposalSnapshot: proposal.snapshot,
          acceptedSnapshot: JSON.stringify(snapshot),
          differences: JSON.stringify(proposalDifferences(original, snapshot)),
          acknowledgedWarnings: JSON.stringify(input.acknowledgedWarningCodes),
        },
      });
      await transaction.correctionEvent.createMany({
        data: correctionComparisons(original, snapshot).map((comparison) => ({
          decisionId: decision.id,
          proposalId: proposal.id,
          attemptId: proposal.attemptId,
          receiptId,
          extractionProfileVersion: proposal.extractionProfileVersion,
          provider: proposal.attempt.provider,
          model: proposal.attempt.model,
          fieldPath: comparison.path,
          fieldKind: comparison.fieldKind,
          sourcePosition: comparison.sourcePosition,
          correctionKind: comparison.correctionKind,
          proposedValue: JSON.stringify(comparison.proposed),
          acceptedValue: JSON.stringify(comparison.accepted),
          originalCategoryProvenance:
            comparison.fieldKind === "categoryId" &&
            comparison.sourcePosition !== null
              ? (original.lineItems[comparison.sourcePosition]
                  ?.categoryProvenance ?? null)
              : null,
        })),
      });
      await transaction.extractionProposal.update({
        where: { id: proposalId },
        data: { status: "approved" },
      });
      return { status: "approved" as const };
    });
  }

  async quality(query: CorrectionQualityQuery) {
    const events = await this.database.correctionEvent.findMany({
      where: {
        ...(query.profileVersion
          ? { extractionProfileVersion: query.profileVersion }
          : {}),
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.model ? { model: query.model } : {}),
        ...(query.fieldKind ? { fieldKind: query.fieldKind } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from
                  ? { gte: new Date(`${query.from}T00:00:00.000Z`) }
                  : {}),
                ...(query.to
                  ? {
                      lt: new Date(
                        new Date(`${query.to}T00:00:00.000Z`).getTime() +
                          86_400_000,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    type Counts = {
      proposedFields: number;
      changedFields: number;
      unchangedFields: number;
      missingFilled: number;
      modelValuesRemoved: number;
      acceptedModelCategories: number;
      correctedModelCategories: number;
      clearedModelCategories: number;
      exactRuleCategories: number;
      unassignedCategories: number;
    };
    const blank = (): Counts => ({
      proposedFields: 0,
      changedFields: 0,
      unchangedFields: 0,
      missingFilled: 0,
      modelValuesRemoved: 0,
      acceptedModelCategories: 0,
      correctedModelCategories: 0,
      clearedModelCategories: 0,
      exactRuleCategories: 0,
      unassignedCategories: 0,
    });
    const increment = (counts: Counts, event: (typeof events)[number]) => {
      const kind = event.correctionKind;
      counts.proposedFields++;
      if (kind === "unchanged") counts.unchangedFields++;
      else counts.changedFields++;
      if (kind === "missing_filled") counts.missingFilled++;
      if (kind === "value_removed") counts.modelValuesRemoved++;
      if (event.fieldKind !== "categoryId") return;
      const accepted = JSON.parse(event.acceptedValue) as string | null;
      const outcome = categoryQualityOutcome(
        event.originalCategoryProvenance,
        kind,
        accepted,
      );
      if (outcome === "accepted_model") counts.acceptedModelCategories++;
      else if (outcome === "corrected_model") counts.correctedModelCategories++;
      else if (outcome === "cleared_model") counts.clearedModelCategories++;
      else if (outcome === "exact_rule") counts.exactRuleCategories++;
      else if (outcome === "unassigned") counts.unassignedCategories++;
    };
    const totals = blank();
    const grouped = new Map<string, Counts>();
    for (const event of events) {
      increment(totals, event);
      const key = JSON.stringify([
        event.extractionProfileVersion,
        event.provider,
        event.model,
        event.fieldKind,
      ]);
      const counts = grouped.get(key) ?? blank();
      increment(counts, event);
      grouped.set(key, counts);
    }
    const rate = (counts: Counts) =>
      counts.proposedFields === 0
        ? 0
        : counts.changedFields / counts.proposedFields;
    return correctionQualitySummarySchema.parse({
      filters: query,
      totals: { ...totals, correctionRate: rate(totals) },
      buckets: [...grouped.entries()].map(([key, counts]) => {
        const [profileVersion, provider, model, fieldKind] = JSON.parse(
          key,
        ) as string[];
        return {
          profileVersion,
          provider,
          model,
          fieldKind,
          ...counts,
          correctionRate: rate(counts),
        };
      }),
    });
  }

  async reject(receiptId: string, proposalId: string) {
    return this.database.$transaction(async (transaction) => {
      const proposal = await transaction.extractionProposal.findFirst({
        where: { id: proposalId, receiptId, status: "pending" },
      });
      if (!proposal) throw new ConflictError("Proposal is stale or superseded");
      await transaction.extractionDecision.create({
        data: {
          proposalId,
          kind: "rejected",
          actor: "local-user",
          proposalSnapshot: proposal.snapshot,
        },
      });
      await transaction.extractionProposal.update({
        where: { id: proposalId },
        data: { status: "rejected" },
      });
      return { status: "rejected" as const };
    });
  }

  async reprocess(receiptId: string) {
    const receipt = await this.receipt(receiptId);
    const document = await this.database.receiptDocument.findUnique({
      where: { receiptId: receipt.id },
    });
    if (!document?.normalizationRevision)
      throw new ConflictError("Receipt document is not normalized");
    const job = await this.database.extractionJob.findUnique({
      where: {
        documentId_normalizationRevision: {
          documentId: document.id,
          normalizationRevision: document.normalizationRevision,
        },
      },
    });
    if (!job) throw new NotFoundError("Extraction job not found");
    if (["pending", "running", "retry_wait"].includes(job.status))
      throw new ConflictError("Receipt extraction is already active");
    await this.database.extractionJob.update({
      where: { id: job.id },
      data: {
        status: "pending",
        maxAttempts: job.attempts + this.maxAttempts,
        availableAt: new Date(),
        lastErrorKind: null,
      },
    });
    return { status: "pending" as const };
  }
}
