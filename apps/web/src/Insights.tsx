import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  merchantBrandListSchema,
  merchantStoreListSchema,
  spendingReportQuerySchema,
  spendingReportSchema,
  spendingWorkflowSummarySchema,
  type Category,
  type MerchantBrand,
  type MerchantStore,
  type SpendingReport,
  type SpendingReportQuery,
} from "@receipt-report/contracts";
import { loadCategories } from "./Categories.js";
import {
  DateField,
  dateRangeError,
  displayDate,
  parseDateInput,
} from "./DateField.js";
import { CategoryComposition } from "./CategoryComposition.js";

const euros = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const currentTime = () => new Date();

function defaults() {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

export type PeriodPresetKey =
  "this-week" | "this-month" | "last-month" | "this-year";

export type PeriodPreset = {
  key: PeriodPresetKey;
  label: string;
  from: string;
  to: string;
};

function berlinCalendarDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function calendarDate(year: number, monthIndex: number, day: number): string {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function periodPresets(instant: Date): PeriodPreset[] {
  const today = berlinCalendarDate(instant);
  const [yearText, monthText, dayText] = today.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const localDate = new Date(Date.UTC(year, monthIndex, day));
  const mondayOffset = (localDate.getUTCDay() + 6) % 7;
  return [
    {
      key: "this-week",
      label: "This week",
      from: calendarDate(year, monthIndex, day - mondayOffset),
      to: today,
    },
    {
      key: "this-month",
      label: "This month",
      from: calendarDate(year, monthIndex, 1),
      to: today,
    },
    {
      key: "this-year",
      label: "This year",
      from: calendarDate(year, 0, 1),
      to: today,
    },
    {
      key: "last-month",
      label: "Last month",
      from: calendarDate(year, monthIndex - 1, 1),
      to: calendarDate(year, monthIndex, 0),
    },
  ];
}

export function activePeriodPreset(
  from: string,
  to: string,
  presets: PeriodPreset[],
): PeriodPresetKey | null {
  return (
    presets.find((preset) => preset.from === from && preset.to === to)?.key ??
    null
  );
}

function receiptHref(apiUrl: string, extra?: Record<string, string>) {
  const url = new URL(apiUrl, location.origin);
  for (const [key, value] of Object.entries(extra ?? {}))
    url.searchParams.set(key, value);
  return `/receipts${url.search}`;
}

function DashboardLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return <a href={href}>{children}</a>;
}

type Draft = {
  from: string;
  to: string;
  categoryId: string;
  categorySubtree: boolean;
  merchantBrandId: string;
  merchantStoreId: string;
  merchantQuery: string;
  provenance: string;
};

function readFilters(search: string) {
  const parameters = new URLSearchParams(search);
  const fallback = defaults();
  const hasFrom = parameters.has("from");
  const hasTo = parameters.has("to");
  const suppliedRange = hasFrom || hasTo;
  const incompleteRange = hasFrom !== hasTo;
  if (!parameters.has("from")) parameters.set("from", fallback.from);
  if (!parameters.has("to")) parameters.set("to", fallback.to);
  const parsed = incompleteRange
    ? { success: false as const }
    : spendingReportQuerySchema.safeParse(Object.fromEntries(parameters));
  const query: SpendingReportQuery = parsed.success
    ? parsed.data
    : { ...fallback, categorySubtree: false };
  return {
    query,
    invalid: !parsed.success,
    suppliedRange,
  };
}

function draftFrom(query: SpendingReportQuery): Draft {
  return {
    from: displayDate(query.from),
    to: displayDate(query.to),
    categoryId: query.categoryId ?? "",
    categorySubtree: query.categorySubtree,
    merchantBrandId: query.merchantBrandId ?? "",
    merchantStoreId: query.merchantStoreId ?? "",
    merchantQuery: query.merchantQuery ?? "",
    provenance: query.provenance ?? "",
  };
}

function Breakdown({
  title,
  items,
}: {
  title: string;
  items: SpendingReport["monthly"];
}) {
  const headingId = `breakdown-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className="insight-breakdown panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {items.length === 0 ? (
        <p className="muted">No amounts in this view.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col">Receipts</th>
                <th scope="col">Gross</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}>
                  <th scope="row">
                    <DashboardLink href={receiptHref(item.drillDownUrl)}>
                      {item.label}
                    </DashboardLink>
                  </th>
                  <td>{item.receiptCount}</td>
                  <td>{euros.format(item.grossCents / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Insights({ clock = currentTime }: { clock?: () => Date }) {
  const [search, setSearch] = useState(location.search);
  const parsed = useMemo(() => readFilters(search), [search]);
  const [draft, setDraft] = useState(() => draftFrom(parsed.query));
  const [report, setReport] = useState<SpendingReport | null>(null);
  const [workflow, setWorkflow] = useState<ReturnType<
    typeof spendingWorkflowSummarySchema.parse
  > | null>(null);
  const [error, setError] = useState("");
  const [dateErrors, setDateErrors] = useState<Record<string, string>>({});
  const [workflowError, setWorkflowError] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [brands, setBrands] = useState<MerchantBrand[]>([]);
  const [stores, setStores] = useState<MerchantStore[]>([]);
  const requestNumber = useRef(0);
  const presets = useMemo(() => periodPresets(clock()), [clock]);
  const activePreset = parsed.invalid
    ? null
    : activePeriodPreset(parsed.query.from, parsed.query.to, presets);

  useEffect(() => {
    const update = () => setSearch(location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => setDraft(draftFrom(parsed.query)), [parsed.query]);
  useEffect(() => {
    void Promise.all([
      loadCategories().then((items) =>
        items.filter((item) => item.archivedAt === null),
      ),
      fetch("/api/v1/merchant-brands?limit=100").then(async (response) =>
        response.ok
          ? merchantBrandListSchema.parse(await response.json()).brands
          : [],
      ),
    ])
      .then(([nextCategories, nextBrands]) => {
        setCategories(nextCategories);
        setBrands(nextBrands);
      })
      .catch(() => {
        setCategories([]);
        setBrands([]);
      });
  }, []);
  useEffect(() => {
    if (!draft.merchantBrandId) return setStores([]);
    void fetch(
      `/api/v1/merchant-stores?brandId=${encodeURIComponent(draft.merchantBrandId)}&limit=100`,
    )
      .then(async (response) =>
        response.ok
          ? merchantStoreListSchema.parse(await response.json()).stores
          : [],
      )
      .then(setStores)
      .catch(() => setStores([]));
  }, [draft.merchantBrandId]);
  useEffect(() => {
    const controller = new AbortController();
    const current = ++requestNumber.current;
    setReport(null);
    setError("");
    setWorkflow(null);
    setWorkflowError(false);
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.query))
      if (value !== undefined && value !== false)
        parameters.set(key, String(value));
    const spendingRequest = fetch(`/api/v1/reports/spending?${parameters}`, {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("spending");
      return spendingReportSchema.parse(await response.json());
    });
    const workflowRequest = fetch("/api/v1/reports/workflow", {
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("workflow");
      return spendingWorkflowSummarySchema.parse(await response.json());
    });
    void Promise.allSettled([spendingRequest, workflowRequest])
      .then(([spendingResult, workflowResult]) => {
        if (requestNumber.current !== current) return;
        if (spendingResult.status === "fulfilled")
          setReport(spendingResult.value);
        else
          setError(
            "Spending insights could not be loaded. No previous totals are shown as current.",
          );
        if (workflowResult.status === "fulfilled")
          setWorkflow(workflowResult.value);
        else setWorkflowError(true);
      })
      .catch((reason: unknown) => {
        if (
          !(reason instanceof DOMException && reason.name === "AbortError") &&
          requestNumber.current === current
        )
          setError(
            "Spending insights could not be loaded. No previous totals are shown as current.",
          );
      });
    return () => controller.abort();
  }, [parsed.query]);

  function apply(event: FormEvent) {
    event.preventDefault();
    const from = parseDateInput(draft.from);
    const to = parseDateInput(draft.to);
    const range =
      !from.error && !to.error ? dateRangeError(draft.from, draft.to) : null;
    const nextErrors = {
      ...(from.error ? { from: from.error } : {}),
      ...(to.error ? { to: to.error } : {}),
      ...(range ? { to: range } : {}),
    };
    setDateErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries({
      ...draft,
      from: from.iso,
      to: to.iso,
    }))
      if (value !== "" && value !== false) parameters.set(key, String(value));
    history.pushState({}, "", `/insights?${parameters}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function applyPreset(preset: PeriodPreset) {
    setDateErrors({});
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries({
      ...parsed.query,
      from: preset.from,
      to: preset.to,
    }))
      if (value !== undefined && value !== false)
        parameters.set(key, String(value));
    history.pushState({}, "", `/insights?${parameters}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  const workflowLabels = [
    ["preparing", "preparing", "Preparing"],
    ["queued", "queued", "Queued"],
    ["processing", "processing", "Processing"],
    ["needsReview", "needs-review", "Needs review"],
    ["failed", "failed", "Failed"],
  ] as const;
  return (
    <section className="insights" aria-labelledby="insights-title">
      <div className="insights-heading">
        <div>
          <p className="eyebrow">Financial overview</p>
          <h1 id="insights-title">Spending insights</h1>
          <p className="intro">
            {parsed.suppliedRange
              ? "Selected date range"
              : "Year to date · default view"}
            . Every amount links back to its receipts.
          </p>
        </div>
      </div>
      {parsed.invalid && (
        <div className="notice notice--warning" role="alert">
          Some URL filters were invalid. A safe year-to-date view is shown
          instead.
        </div>
      )}
      <form className="insight-filters panel" onSubmit={apply}>
        <fieldset className="period-presets">
          <legend>Quick period</legend>
          <div>
            {presets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="button button--quiet button--small"
                aria-pressed={activePreset === preset.key}
                onClick={() => applyPreset(preset)}
              >
                {preset.label}
              </button>
            ))}
            {!activePreset && <span className="period-custom">Custom</span>}
          </div>
        </fieldset>
        <DateField
          id="insights-from"
          label="From"
          value={draft.from}
          error={dateErrors.from}
          className="insight-date-field"
          onChange={(value) => setDraft({ ...draft, from: value })}
        />
        <DateField
          id="insights-to"
          label="To"
          value={draft.to}
          error={dateErrors.to}
          className="insight-date-field"
          onChange={(value) => setDraft({ ...draft, to: value })}
        />
        <label>
          Category
          <select
            aria-label="Category"
            value={draft.categoryId}
            onChange={(event) =>
              setDraft({ ...draft, categoryId: event.target.value })
            }
          >
            <option value="">All categories</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Brand
          <select
            aria-label="Brand"
            value={draft.merchantBrandId}
            onChange={(event) =>
              setDraft({
                ...draft,
                merchantBrandId: event.target.value,
                merchantStoreId: "",
              })
            }
          >
            <option value="">All brands</option>
            {brands.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Store
          <select
            aria-label="Store"
            value={draft.merchantStoreId}
            disabled={!draft.merchantBrandId}
            onChange={(event) =>
              setDraft({ ...draft, merchantStoreId: event.target.value })
            }
          >
            <option value="">All stores</option>
            {stores.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Raw merchant
          <input
            aria-label="Raw merchant"
            value={draft.merchantQuery}
            onChange={(event) =>
              setDraft({ ...draft, merchantQuery: event.target.value })
            }
          />
        </label>
        <label>
          Source
          <select
            aria-label="Source"
            value={draft.provenance}
            onChange={(event) =>
              setDraft({ ...draft, provenance: event.target.value })
            }
          >
            <option value="">All sources</option>
            <option value="manual">Manual</option>
            <option value="ai_approved">AI approved</option>
            <option value="ai_reprocessed">AI reprocessed</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.categorySubtree}
            onChange={(event) =>
              setDraft({ ...draft, categorySubtree: event.target.checked })
            }
          />
          Include subcategories
        </label>
        <button className="button" type="submit">
          Apply filters
        </button>
      </form>
      {error && (
        <div className="panel state" role="alert">
          <h2>Insights unavailable</h2>
          <p>{error}</p>
        </div>
      )}
      {!report && !error && (
        <div className="panel state" role="status">
          Loading current totals…
        </div>
      )}
      {workflow && (
        <section className="workflow-summary" aria-labelledby="workflow-title">
          <div className="section-heading">
            <h2 id="workflow-title">Receipt workflow</h2>
            <span>Operational counts · no money</span>
          </div>
          <div className="workflow-grid">
            {workflowLabels.map(([key, parameter, label]) => (
              <DashboardLink key={key} href={`/receipts?workflow=${parameter}`}>
                <strong>{workflow[key]}</strong>
                <span>{label}</span>
              </DashboardLink>
            ))}
          </div>
        </section>
      )}
      {workflowError && (
        <div className="notice notice--warning" role="status">
          Receipt workflow counts are temporarily unavailable. Spending amounts
          below are unaffected.
        </div>
      )}
      {report && report.totals.receiptCount === 0 && (
        <div className="panel empty">
          <h2>No spending in this view</h2>
          <p>Adjust the filters or add receipts for this period.</p>
        </div>
      )}
      {report && report.totals.receiptCount > 0 && (
        <>
          <section className="metric-grid" aria-label="Spending totals">
            <article className="metric metric--primary">
              <span>Gross spend</span>
              <strong>{euros.format(report.totals.grossCents / 100)}</strong>
            </article>
            <article className="metric">
              <span>Receipts</span>
              <strong>{report.totals.receiptCount}</strong>
            </article>
            <article className="metric">
              <span>Average receipt</span>
              <strong>
                {euros.format((report.totals.averageReceiptCents ?? 0) / 100)}
              </strong>
            </article>
            <article className="metric">
              <span>Net</span>
              <strong>
                {report.totals.netCents === null
                  ? "Not available"
                  : euros.format(report.totals.netCents / 100)}
              </strong>
              <small>
                {report.totals.coverage.net} of{" "}
                {report.totals.coverage.receipts} receipts covered
              </small>
            </article>
            <article className="metric">
              <span>Tax</span>
              <strong>
                {report.totals.taxCents === null
                  ? "Not available"
                  : euros.format(report.totals.taxCents / 100)}
              </strong>
              <small>
                {report.totals.coverage.tax} of{" "}
                {report.totals.coverage.receipts} receipts covered
              </small>
            </article>
          </section>
          <div className="breakdown-grid">
            <Breakdown title="Monthly trend" items={report.monthly} />
            <CategoryComposition
              title="Categories"
              buckets={report.categories.map((item) => ({
                key: item.key,
                label: item.label,
                signedCents: item.grossCents,
                receiptCount: item.receiptCount,
                drillDownUrl: receiptHref(item.drillDownUrl),
              }))}
            />
            <Breakdown title="Brands" items={report.merchantBrands} />
            <Breakdown title="Stores" items={report.merchantStores} />
            <Breakdown title="Printed merchants" items={report.rawMerchants} />
          </div>
        </>
      )}
    </section>
  );
}
