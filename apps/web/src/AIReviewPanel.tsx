import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiErrorSchema,
  extractionProposalHistorySchema,
  extractionProposalSchema,
  extractionStatusResponseSchema,
  receiptDocumentResponseSchema,
  type Category,
  type ExtractionProposal,
  type ProposalSnapshot,
} from "@receipt-report/contracts";
import { CategoryOptions, categoryLabel } from "./Categories.js";
import { rememberCategoryRule } from "./CategorySuggestionRules.js";
import { DateField, displayDate, parseDateInput } from "./DateField.js";

type Phase =
  | "idle"
  | "preparing"
  | "queued"
  | "processing"
  | "needs-review"
  | "failed"
  | "approved";

const phaseCopy: Record<Phase, string> = {
  idle: "No AI extraction",
  preparing: "Preparing",
  queued: "Queued",
  processing: "Processing",
  "needs-review": "Needs review",
  failed: "Extraction failed",
  approved: "Approved",
};

type Lifecycle = {
  phase: Phase;
  proposal: ExtractionProposal | null;
  failureKind: string | null;
  refresh: () => Promise<void>;
  resumePolling: () => void;
};

function useLifecycle(receiptId: string): Lifecycle {
  const [phase, setPhase] = useState<Phase>("idle");
  const [proposal, setProposal] = useState<ExtractionProposal | null>(null);
  const [failureKind, setFailureKind] = useState<string | null>(null);
  const [pollGeneration, setPollGeneration] = useState(0);

  const refresh = useCallback(async () => {
    const documentResponse = await fetch(
      `/api/v1/receipts/${receiptId}/document`,
    );
    if (documentResponse.status === 404) {
      setPhase("idle");
      setProposal(null);
      return;
    }
    if (!documentResponse.ok) throw new Error("document");
    const document = receiptDocumentResponseSchema.parse(
      await documentResponse.json(),
    );
    if (document.normalizationStatus !== "complete") {
      setPhase(
        document.normalizationStatus === "failed" ? "failed" : "preparing",
      );
      setFailureKind(document.normalizationError);
      return;
    }
    const statusResponse = await fetch(
      `/api/v1/receipts/${receiptId}/document/extraction`,
    );
    if (statusResponse.status === 404) {
      setPhase("queued");
      return;
    }
    if (!statusResponse.ok) throw new Error("status");
    const status = extractionStatusResponseSchema.parse(
      await statusResponse.json(),
    );
    if (status.status === "failed") {
      setPhase("failed");
      setFailureKind(status.lastErrorKind);
      return;
    }
    if (status.status === "pending" || status.status === "retry_wait") {
      setPhase("queued");
      return;
    }
    if (status.status === "running") {
      setPhase("processing");
      return;
    }
    if (status.status === "cancelled") {
      setPhase("queued");
      return;
    }
    const proposalResponse = await fetch(
      `/api/v1/receipts/${receiptId}/extraction-proposal`,
    );
    if (proposalResponse.ok) {
      setProposal(
        extractionProposalSchema.parse(await proposalResponse.json()),
      );
      setPhase("needs-review");
      return;
    }
    const historyResponse = await fetch(
      `/api/v1/receipts/${receiptId}/extraction-proposals`,
    );
    if (historyResponse.ok) {
      const history = extractionProposalHistorySchema.parse(
        await historyResponse.json(),
      );
      setPhase(
        history.proposals.some((item) => item.status === "approved")
          ? "approved"
          : "queued",
      );
    }
  }, [receiptId]);

  useEffect(() => {
    let active = true;
    let attempt = 0;
    let timer: number | undefined;
    const poll = async () => {
      if (!active || document.hidden) return;
      try {
        await refresh();
      } catch {
        // A later bounded poll may recover. Action errors are surfaced by the panel.
      }
      attempt += 1;
      if (
        active &&
        attempt < 40 &&
        ["preparing", "queued", "processing", "idle"].includes(phase)
      )
        timer = window.setTimeout(() => void poll(), 750);
    };
    const visible = () => {
      if (!document.hidden && active) {
        attempt = 0;
        window.clearTimeout(timer);
        void poll();
      }
    };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, pollGeneration, phase]);
  const resumePolling = useCallback(
    () => setPollGeneration((generation) => generation + 1),
    [],
  );
  return { phase, proposal, failureKind, refresh, resumePolling };
}

export function ReceiptLifecycleBadge({ receiptId }: { receiptId: string }) {
  const { phase } = useLifecycle(receiptId);
  if (phase === "idle") return null;
  return (
    <span
      className={`ai-badge ai-badge--${phase}`}
      aria-label={`AI: ${phaseCopy[phase]}`}
    >
      {phaseCopy[phase]}
    </span>
  );
}

export function formatSignedMoney(value: number | null): string {
  if (value === null) return "";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
}

export function parseSignedMoney(value: string): number | null {
  const match = /^(-?)(\d+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents =
    Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  const signed = match[1] === "-" ? -cents : cents;
  return Number.isSafeInteger(signed) ? signed : null;
}

type Draft = {
  merchantRaw: string;
  merchantBrandId: string | null;
  merchantStoreId: string | null;
  purchaseDate: string;
  purchaseTime: string;
  total: string;
  net: string;
  tax: string;
  lines: {
    description: string;
    quantityMilli: string;
    unitPrice: string;
    lineTotal: string;
    categoryId: string | null;
    kind: ProposalSnapshot["lineItems"][number]["kind"];
  }[];
};

function draftFrom(snapshot: ProposalSnapshot): Draft {
  return {
    merchantRaw: snapshot.merchantRaw,
    merchantBrandId: snapshot.merchantBrandId,
    merchantStoreId: snapshot.merchantStoreId,
    purchaseDate: displayDate(snapshot.purchaseDate),
    purchaseTime: snapshot.purchaseTime ?? "",
    total: formatSignedMoney(snapshot.totalCents),
    net: formatSignedMoney(snapshot.netCents),
    tax: formatSignedMoney(snapshot.taxCents),
    lines: snapshot.lineItems.map((line) => ({
      description: line.description,
      quantityMilli:
        line.quantityMilli === null ? "" : String(line.quantityMilli),
      unitPrice: formatSignedMoney(line.unitPriceCents),
      lineTotal: formatSignedMoney(line.lineTotalCents),
      categoryId: line.categoryId,
      kind: line.kind,
    })),
  };
}

export function proposalFieldId(path: string | null): string | undefined {
  if (!path) return undefined;
  const line = /^lineItems\.(\d+)\.(.+)$/.exec(path);
  if (line) return `proposal-line-${line[1]}-${line[2]}`;
  return `proposal-${path}`;
}

function confidence(value: number | null) {
  if (value === null) return <small className="confidence">Not supplied</small>;
  return (
    <small
      className={value < 0.7 ? "confidence confidence--low" : "confidence"}
    >
      {Math.round(value * 100)}% confidence
    </small>
  );
}

export function AIReviewPanel({
  receiptId,
  receiptUpdatedAt,
  categories,
  canonicalDirty,
  onApproved,
}: {
  receiptId: string;
  receiptUpdatedAt: string;
  categories: Category[];
  canonicalDirty: boolean;
  onApproved: () => Promise<void>;
}) {
  const lifecycle = useLifecycle(receiptId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState<Draft | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [stale, setStale] = useState(false);
  const [categoryTouched, setCategoryTouched] = useState<Set<number>>(
    new Set(),
  );
  const [categorySources, setCategorySources] = useState<
    Map<number, "manual" | "exact_rule">
  >(new Map());
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());
  const userToggledLines = useRef<Set<number>>(new Set());
  const messageRef = useRef<HTMLDivElement>(null);
  const dirty =
    !!draft && !!source && JSON.stringify(draft) !== JSON.stringify(source);

  useEffect(() => {
    const proposal = lifecycle.proposal;
    if (!proposal || proposal.id === proposalId) return;
    if (dirty) {
      setStale(true);
      return;
    }
    const next = draftFrom(proposal.snapshot);
    setDraft(next);
    setSource(next);
    setProposalId(proposal.id);
    setAcknowledged(new Set());
    setStale(false);
    setCategoryTouched(new Set());
    setCategorySources(new Map());
    const attention = new Set<number>();
    proposal.snapshot.lineItems.forEach((line, index) => {
      if (
        [
          line.descriptionConfidence,
          line.lineTotalConfidence,
          line.categoryConfidence,
        ].some((value) => value != null && value < 0.7) ||
        !line.description.trim()
      )
        attention.add(index);
    });
    proposal.findings.forEach((finding) => {
      const match = finding.fieldPath?.match(/^lineItems\.(\d+)(?:\.|$)/);
      if (match) attention.add(Number(match[1]));
    });
    setExpandedLines(attention);
    userToggledLines.current.clear();
  }, [lifecycle.proposal, proposalId, dirty]);

  const warningCodes = useMemo(
    () => [
      ...new Set(
        lifecycle.proposal?.findings
          .filter((finding) => finding.severity === "warning")
          .map((finding) => finding.code) ?? [],
      ),
    ],
    [lifecycle.proposal],
  );

  const announce = (value: string, isError = false) => {
    setMessage(value);
    if (isError) requestAnimationFrame(() => messageRef.current?.focus());
  };

  async function action(path: string, method = "POST", body?: unknown) {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method,
        ...(body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(
          await response.json().catch(() => null),
        );
        const errorMessage = parsed.success
          ? parsed.data.error.message
          : "Request failed";
        if (
          response.status === 409 &&
          /stale|superseded|changed/i.test(errorMessage)
        )
          setStale(true);
        throw new Error(errorMessage);
      }
      return response;
    } finally {
      setBusy(false);
    }
  }

  function snapshot(): ProposalSnapshot | null {
    if (!draft || !lifecycle.proposal) return null;
    const total = parseSignedMoney(draft.total);
    const net = draft.net ? parseSignedMoney(draft.net) : null;
    const tax = draft.tax ? parseSignedMoney(draft.tax) : null;
    const purchaseDate = parseDateInput(draft.purchaseDate);
    if (purchaseDate.iso === null) return null;
    const lines = draft.lines.map((line, index) => ({
      sourcePosition: index,
      description: line.description,
      descriptionConfidence:
        lifecycle.proposal?.snapshot.lineItems[index]?.descriptionConfidence ??
        null,
      quantityMilli: line.quantityMilli ? Number(line.quantityMilli) : null,
      unitPriceCents: line.unitPrice ? parseSignedMoney(line.unitPrice) : null,
      lineTotalCents: parseSignedMoney(line.lineTotal),
      lineTotalConfidence:
        lifecycle.proposal?.snapshot.lineItems[index]?.lineTotalConfidence ??
        null,
      categoryId: line.categoryId,
      categoryConfidence:
        lifecycle.proposal?.snapshot.lineItems[index]?.categoryConfidence ??
        null,
      categorySuggestion:
        lifecycle.proposal?.snapshot.lineItems[index]?.categorySuggestion ??
        null,
      categoryProvenance:
        categorySources.get(index) ??
        (line.categoryId !==
        lifecycle.proposal?.snapshot.lineItems[index]?.categoryId
          ? "manual"
          : (lifecycle.proposal?.snapshot.lineItems[index]
              ?.categoryProvenance ?? null)),
      kind: line.kind,
    }));
    if (
      total === null ||
      (draft.net && net === null) ||
      (draft.tax && tax === null) ||
      lines.some(
        (line) =>
          line.lineTotalCents === null ||
          (line.quantityMilli !== null &&
            (!Number.isSafeInteger(line.quantityMilli) ||
              line.quantityMilli <= 0)) ||
          (draft.lines[line.sourcePosition]?.unitPrice &&
            line.unitPriceCents === null),
      )
    )
      return null;
    return {
      merchantRaw: draft.merchantRaw,
      merchantConfidence: lifecycle.proposal.snapshot.merchantConfidence,
      merchantBrandId: draft.merchantBrandId,
      merchantStoreId: draft.merchantStoreId,
      purchaseDate: purchaseDate.iso,
      purchaseDateConfidence:
        lifecycle.proposal.snapshot.purchaseDateConfidence,
      purchaseTime: draft.purchaseTime || null,
      purchaseTimeConfidence:
        lifecycle.proposal.snapshot.purchaseTimeConfidence,
      currency: "EUR",
      totalCents: total,
      totalConfidence: lifecycle.proposal.snapshot.totalConfidence,
      netCents: net,
      taxCents: tax,
      lineItems: lines.map((line) => ({
        ...line,
        lineTotalCents: line.lineTotalCents as number,
      })),
    };
  }

  async function remember(index: number) {
    const line = draft?.lines[index];
    if (!line?.categoryId || !line.description.trim()) return;
    const available = [
      "global",
      ...(draft?.merchantBrandId ? ["brand"] : []),
      ...(draft?.merchantStoreId ? ["store"] : []),
    ];
    const scope = window.prompt(
      `Choose rule scope (${available.join(" / ")}):`,
      available.at(-1),
    );
    if (!scope || !available.includes(scope)) return;
    if (
      !window.confirm(
        `Remember the exact description “${line.description}” for this ${scope} scope?`,
      )
    )
      return;
    try {
      const result = await rememberCategoryRule({
        description: line.description,
        categoryId: line.categoryId,
        scopeKind: scope as "global" | "brand" | "store",
        brandId: scope === "global" ? null : (draft?.merchantBrandId ?? null),
        storeId: scope === "store" ? (draft?.merchantStoreId ?? null) : null,
      });
      announce(
        result === "cancelled"
          ? "The existing category rule was left unchanged."
          : "Category rule remembered locally for future extractions.",
      );
    } catch {
      announce("The category rule could not be remembered.", true);
    }
  }

  async function approve() {
    const accepted = snapshot();
    if (!accepted)
      return announce("Correct the invalid proposal amounts first.", true);
    if (canonicalDirty)
      return announce(
        "Save or discard canonical receipt edits before approval.",
        true,
      );
    try {
      await action(
        `/api/v1/receipts/${receiptId}/extraction-proposals/${proposalId}/approve`,
        "POST",
        {
          receiptUpdatedAt,
          normalizationRevision: lifecycle.proposal?.normalizationRevision,
          snapshot: accepted,
          acknowledgedWarningCodes: [...acknowledged],
        },
      );
      setSource(draft);
      announce("Proposal approved. The reviewed values are now canonical.");
      await onApproved();
      await lifecycle.refresh();
    } catch (error) {
      announce(
        error instanceof Error &&
          error.message === "Proposal contains blocking findings"
          ? "Resolve the blocking findings before approval. Your review edits are still here."
          : "Approval did not complete. Your review edits are still here; refresh stale data or try again.",
        true,
      );
    }
  }

  async function reject() {
    if (
      !window.confirm(
        dirty
          ? "Discard your proposal edits and reject it?"
          : "Reject this proposal?",
      )
    )
      return;
    try {
      await action(
        `/api/v1/receipts/${receiptId}/extraction-proposals/${proposalId}/reject`,
      );
      announce("Proposal rejected. Canonical receipt data was not changed.");
      await lifecycle.refresh();
    } catch {
      announce(
        "The proposal could not be rejected. Your edits are still here.",
        true,
      );
    }
  }

  async function retry(reprocess = false) {
    if (
      reprocess &&
      !window.confirm(
        "Reprocess this approved receipt? Approved values will remain authoritative.",
      )
    )
      return;
    try {
      await action(
        reprocess
          ? `/api/v1/receipts/${receiptId}/extraction/reprocess`
          : `/api/v1/receipts/${receiptId}/document/extraction/retry`,
      );
      announce(
        reprocess
          ? "Reprocessing queued. Approved values are unchanged."
          : "Retry queued.",
      );
      lifecycle.resumePolling();
    } catch {
      announce("The extraction could not be queued. Try again.", true);
    }
  }

  const updateLine = (index: number, patch: Partial<Draft["lines"][number]>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((line, at) =>
              at === index ? { ...line, ...patch } : line,
            ),
          }
        : current,
    );

  return (
    <section className="panel ai-review" aria-labelledby="ai-review-title">
      <header className="ai-review__header">
        <div>
          <p className="eyebrow">Automatic extraction</p>
          <h2 id="ai-review-title">AI review</h2>
        </div>
        <span className={`ai-badge ai-badge--${lifecycle.phase}`} role="status">
          {phaseCopy[lifecycle.phase]}
        </span>
      </header>
      {message && (
        <div
          ref={messageRef}
          tabIndex={-1}
          className="ai-message"
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      )}
      {stale && (
        <div className="banner banner--error" role="alert">
          The receipt, document, or proposal changed. Your local edits were
          kept.
          <button
            type="button"
            className="button button--small button--quiet"
            onClick={() => {
              if (
                !dirty ||
                window.confirm(
                  "Discard local proposal edits and load the newest proposal?",
                )
              ) {
                setDraft(null);
                setSource(null);
                setProposalId(null);
                setStale(false);
                void lifecycle.refresh();
              }
            }}
          >
            Load newest
          </button>
        </div>
      )}
      {["preparing", "queued", "processing"].includes(lifecycle.phase) && (
        <div className="ai-waiting" aria-live="polite">
          <span className="ai-pulse" aria-hidden="true" />
          <div>
            <strong>{phaseCopy[lifecycle.phase]}</strong>
            <p>The canonical receipt remains available while this runs.</p>
          </div>
        </div>
      )}
      {lifecycle.phase === "idle" && (
        <p>Attach a document to start automatic extraction.</p>
      )}
      {lifecycle.phase === "failed" && (
        <div className="ai-failure" role="alert">
          <strong>Extraction needs attention</strong>
          <p>
            Failure: {lifecycle.failureKind ?? "unknown"}. The document and
            receipt are safe.
          </p>
          <button
            className="button button--small"
            disabled={busy}
            onClick={() => void retry()}
          >
            Retry extraction
          </button>
        </div>
      )}
      {lifecycle.phase === "approved" && (
        <div className="ai-approved">
          <strong>Human-reviewed data is authoritative.</strong>
          <p>
            A later extraction will create a new proposal without changing it.
          </p>
          <button
            className="button button--small button--quiet"
            disabled={busy}
            onClick={() => void retry(true)}
          >
            Reprocess receipt
          </button>
        </div>
      )}
      {lifecycle.phase === "needs-review" && draft && lifecycle.proposal && (
        <>
          <p className="ai-review__notice">
            These are proposed values. Nothing below is saved to the receipt
            until you approve.
          </p>
          {lifecycle.proposal.findings.length > 0 && (
            <nav className="finding-list" aria-label="Extraction findings">
              {lifecycle.proposal.findings.map((finding, index) => (
                <button
                  key={`${finding.code}-${finding.fieldPath}-${index}`}
                  type="button"
                  className={`finding finding--${finding.severity}`}
                  onClick={() => {
                    const id = proposalFieldId(finding.fieldPath);
                    const match = finding.fieldPath?.match(
                      /^lineItems\.(\d+)(?:\.|$)/,
                    );
                    if (match) {
                      const lineIndex = Number(match[1]);
                      setExpandedLines((current) =>
                        new Set(current).add(lineIndex),
                      );
                    }
                    if (id) {
                      if (match)
                        requestAnimationFrame(() =>
                          document.getElementById(id)?.focus(),
                        );
                      else document.getElementById(id)?.focus();
                    }
                  }}
                >
                  <strong>{finding.severity}</strong> {finding.message}
                </button>
              ))}
            </nav>
          )}
          <div className="proposal-fields">
            <label className="field field--wide">
              <span>Merchant</span>
              <input
                id="proposal-merchantRaw"
                value={draft.merchantRaw}
                onChange={(event) =>
                  setDraft({ ...draft, merchantRaw: event.target.value })
                }
              />
              {confidence(lifecycle.proposal.snapshot.merchantConfidence)}
            </label>
            <div>
              <DateField
                id="proposal-purchaseDate"
                label="Purchase date"
                value={draft.purchaseDate}
                error={parseDateInput(draft.purchaseDate).error ?? undefined}
                onChange={(value) =>
                  setDraft({ ...draft, purchaseDate: value })
                }
              />
              {confidence(lifecycle.proposal.snapshot.purchaseDateConfidence)}
            </div>
            <label className="field">
              <span>Time</span>
              <input
                id="proposal-purchaseTime"
                type="time"
                value={draft.purchaseTime}
                onChange={(event) =>
                  setDraft({ ...draft, purchaseTime: event.target.value })
                }
              />
              {confidence(lifecycle.proposal.snapshot.purchaseTimeConfidence)}
            </label>
            {(["total", "net", "tax"] as const).map((name) => (
              <label className="field" key={name}>
                <span>
                  {name === "total"
                    ? "Gross total"
                    : name === "net"
                      ? "Net total"
                      : "Tax"}
                </span>
                <input
                  id={`proposal-${name === "total" ? "totalCents" : `${name}Cents`}`}
                  inputMode="decimal"
                  value={draft[name]}
                  onChange={(event) =>
                    setDraft({ ...draft, [name]: event.target.value })
                  }
                />
                {name === "total" &&
                  confidence(
                    lifecycle.proposal?.snapshot.totalConfidence ?? null,
                  )}
              </label>
            ))}
          </div>
          <div className="proposal-lines">
            <h3>Proposed line items</h3>
            <div
              className="line-table line-table--proposal"
              role="table"
              aria-label="Proposed line items"
            >
              <div className="line-table__header" role="rowgroup">
                <div
                  role="row"
                  className="line-row line-row--proposal line-row--header"
                >
                  <span role="columnheader">Description</span>
                  <span role="columnheader">Quantity</span>
                  <span role="columnheader">Unit price</span>
                  <span role="columnheader">Line total</span>
                  <span role="columnheader">Category</span>
                  <span role="columnheader" aria-label="Details" />
                </div>
              </div>
              <div role="rowgroup">
                {draft.lines.map((line, index) => {
                  const proposed =
                    lifecycle.proposal?.snapshot.lineItems[index];
                  const expanded = expandedLines.has(index);
                  const labelId = `proposal-line-${index}-label`;
                  const detailId = `proposal-line-${index}-details`;
                  return (
                    <div
                      className="line-entry line-entry--proposal"
                      key={index}
                    >
                      <div
                        role="row"
                        className="line-row line-row--proposal"
                        aria-labelledby={labelId}
                      >
                        <div
                          role="cell"
                          className="line-cell line-cell--description"
                          data-label="Description"
                        >
                          <label
                            className="visually-hidden"
                            htmlFor={`proposal-line-${index}-description`}
                          >
                            Description for proposed line {index + 1}
                          </label>
                          <input
                            id={`proposal-line-${index}-description`}
                            title={line.description}
                            value={line.description}
                            onChange={(event) =>
                              updateLine(index, {
                                description: event.target.value,
                              })
                            }
                          />
                          <span id={labelId} className="visually-hidden">
                            Proposed line {index + 1}:{" "}
                            {line.description || "no description"}
                          </span>
                        </div>
                        <div
                          role="cell"
                          className="line-cell"
                          data-label="Quantity"
                        >
                          <label
                            className="visually-hidden"
                            htmlFor={`proposal-line-${index}-quantityMilli`}
                          >
                            Quantity (thousandths)
                          </label>
                          <input
                            id={`proposal-line-${index}-quantityMilli`}
                            inputMode="numeric"
                            value={line.quantityMilli}
                            onChange={(event) =>
                              updateLine(index, {
                                quantityMilli: event.target.value,
                              })
                            }
                          />
                        </div>
                        <div
                          role="cell"
                          className="line-cell"
                          data-label="Unit price"
                        >
                          <label
                            className="visually-hidden"
                            htmlFor={`proposal-line-${index}-unitPriceCents`}
                          >
                            Unit price
                          </label>
                          <input
                            id={`proposal-line-${index}-unitPriceCents`}
                            inputMode="decimal"
                            value={line.unitPrice}
                            onChange={(event) =>
                              updateLine(index, {
                                unitPrice: event.target.value,
                              })
                            }
                          />
                        </div>
                        <div
                          role="cell"
                          className="line-cell"
                          data-label="Line total"
                        >
                          <label
                            className="visually-hidden"
                            htmlFor={`proposal-line-${index}-lineTotalCents`}
                          >
                            Line total
                          </label>
                          <input
                            id={`proposal-line-${index}-lineTotalCents`}
                            inputMode="decimal"
                            value={line.lineTotal}
                            onChange={(event) =>
                              updateLine(index, {
                                lineTotal: event.target.value,
                              })
                            }
                          />
                        </div>
                        <div
                          role="cell"
                          className="line-cell line-cell--category"
                          data-label="Category"
                        >
                          <label
                            className="visually-hidden"
                            htmlFor={`proposal-line-${index}-categoryId`}
                          >
                            Category for proposed line {index + 1}
                          </label>
                          <select
                            id={`proposal-line-${index}-categoryId`}
                            value={line.categoryId ?? ""}
                            onChange={(event) => (
                              updateLine(index, {
                                categoryId: event.target.value || null,
                              }),
                              setCategoryTouched((current) =>
                                new Set(current).add(index),
                              ),
                              setCategorySources((current) =>
                                new Map(current).set(index, "manual"),
                              )
                            )}
                          >
                            <CategoryOptions
                              categories={categories}
                              value={line.categoryId}
                            />
                          </select>
                        </div>
                        <div
                          role="cell"
                          className="line-cell line-cell--toggle"
                          data-label="Details"
                        >
                          <button
                            type="button"
                            className="line-toggle"
                            aria-expanded={expanded}
                            aria-controls={detailId}
                            aria-label={`${expanded ? "Collapse" : "Expand"} details for proposed line ${index + 1}`}
                            onClick={() => {
                              userToggledLines.current.add(index);
                              setExpandedLines((current) => {
                                const next = new Set(current);
                                if (next.has(index)) next.delete(index);
                                else next.add(index);
                                return next;
                              });
                            }}
                          >
                            {expanded ? "−" : "+"}
                          </button>
                        </div>
                      </div>
                      <div
                        role="row"
                        className="line-detail-row"
                        hidden={!expanded}
                      >
                        <div
                          role="cell"
                          className="line-detail proposal-line-detail"
                          id={detailId}
                          aria-labelledby={labelId}
                        >
                          <p className="line-description-full">
                            <strong>Full description:</strong>{" "}
                            {line.description || "No description"}
                          </p>
                          <div className="proposal-detail-grid">
                            <label className="field">
                              <span>Kind</span>
                              <select
                                value={line.kind}
                                onChange={(event) =>
                                  updateLine(index, {
                                    kind: event.target
                                      .value as Draft["lines"][number]["kind"],
                                  })
                                }
                              >
                                <option value="unknown">Unknown</option>
                                <option value="item">Item</option>
                                <option value="discount">Discount</option>
                                <option value="return">Return</option>
                                <option value="deposit">Deposit</option>
                                <option value="deposit_refund">
                                  Deposit refund
                                </option>
                              </select>
                            </label>
                            <div className="proposal-confidence">
                              <strong>Provider confidence</strong>
                              {confidence(
                                proposed?.descriptionConfidence ?? null,
                              )}
                              {confidence(
                                proposed?.lineTotalConfidence ?? null,
                              )}
                            </div>
                            <small className="category-provenance">
                              Source:{" "}
                              {categorySources.get(index) === "manual"
                                ? "manual edit"
                                : categorySources.get(index) === "exact_rule"
                                  ? "exact local rule"
                                  : proposed?.categoryProvenance ===
                                      "exact_rule"
                                    ? "exact local rule"
                                    : proposed?.categoryProvenance === "model"
                                      ? "model"
                                      : "unassigned"}
                            </small>
                            {!categoryTouched.has(index) &&
                              proposed?.categoryProvenance === "model" &&
                              confidence(proposed.categoryConfidence ?? null)}
                            {categoryTouched.has(index) && line.categoryId && (
                              <button
                                type="button"
                                className="button button--small button--quiet"
                                onClick={() => void remember(index)}
                              >
                                Remember for future
                              </button>
                            )}
                            {proposed?.categorySuggestion &&
                              !line.categoryId && (
                                <div className="proposal-suggestion">
                                  <span>
                                    Suggested:{" "}
                                    {categoryLabel(
                                      categories.find(
                                        (category) =>
                                          category.id ===
                                          proposed.categorySuggestion
                                            ?.categoryId,
                                      ) ??
                                        ({
                                          id: proposed.categorySuggestion
                                            .categoryId,
                                          name: "Category",
                                          parentId: null,
                                        } as Category),
                                      categories,
                                    )}{" "}
                                    · {proposed.categorySuggestion.scopeKind}{" "}
                                    rule
                                  </span>
                                  <button
                                    type="button"
                                    className="button button--small button--quiet"
                                    onClick={() => (
                                      updateLine(index, {
                                        categoryId:
                                          proposed.categorySuggestion
                                            ?.categoryId ?? null,
                                      }),
                                      setCategoryTouched((current) =>
                                        new Set(current).add(index),
                                      ),
                                      setCategorySources((current) =>
                                        new Map(current).set(
                                          index,
                                          "exact_rule",
                                        ),
                                      )
                                    )}
                                  >
                                    Adopt suggestion
                                  </button>
                                </div>
                              )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {warningCodes.length > 0 && (
            <fieldset className="warning-acknowledgements">
              <legend>Warnings require acknowledgement</legend>
              {warningCodes.map((code) => (
                <label key={code}>
                  <input
                    type="checkbox"
                    checked={acknowledged.has(code)}
                    onChange={(event) =>
                      setAcknowledged((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(code);
                        else next.delete(code);
                        return next;
                      })
                    }
                  />{" "}
                  I reviewed {code.replaceAll("_", " ")}
                </label>
              ))}
            </fieldset>
          )}
          <div className="ai-review__actions">
            <button
              type="button"
              className="button button--quiet danger"
              disabled={busy}
              onClick={() => void reject()}
            >
              Reject
            </button>
            <button
              type="button"
              className="button"
              disabled={
                busy || warningCodes.some((code) => !acknowledged.has(code))
              }
              onClick={() => void approve()}
            >
              Approve reviewed values
            </button>
          </div>
        </>
      )}
    </section>
  );
}
