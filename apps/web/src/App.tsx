import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  apiErrorSchema,
  categorySchema,
  categorySuggestionSchema,
  correctionQualitySummarySchema,
  merchantBrandListSchema,
  merchantBrandSchema,
  merchantStoreListSchema,
  merchantStoreSchema,
  normalizeMerchantAddressKey,
  normalizeMerchantName,
  receiptDocumentResponseSchema,
  receiptDetailSchema,
  receiptListSchema,
  UPLOAD_PLACEHOLDER_RECEIPT,
  type MerchantBrand,
  type MerchantStore,
  type Category,
  type CategorySuggestionRule,
  type ReceiptDetail,
  type ReceiptSummary,
} from "@receipt-report/contracts";
import {
  CategoryManager,
  CategoryOptions,
  categoryLabel,
  loadCategories,
} from "./Categories.js";
import {
  CategorySuggestionRuleManager,
  rememberCategoryRule,
} from "./CategorySuggestionRules.js";
import {
  DocumentFileField,
  DocumentPanel,
  DocumentUploadError,
  failureMessage,
  uploadReceiptDocument,
} from "./DocumentPanel.js";
import { AIReviewPanel, ReceiptLifecycleBadge } from "./AIReviewPanel.js";
import { Insights } from "./Insights.js";
import {
  DateField,
  dateRangeError,
  displayDate,
  parseDateInput,
} from "./DateField.js";
import {
  CategoryComposition,
  type CompositionBucket,
} from "./CategoryComposition.js";

type Route = {
  page:
    | "list"
    | "new"
    | "detail"
    | "categories"
    | "category-rules"
    | "quality"
    | "insights";
  id?: string;
};
const money = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});
let navigationGuard: (() => boolean) | undefined;
let ignoreNextPop = false;

function route(): Route {
  if (location.pathname === "/categories") return { page: "categories" };
  if (location.pathname === "/category-rules")
    return { page: "category-rules" };
  if (location.pathname === "/extraction-quality") return { page: "quality" };
  if (location.pathname === "/insights") return { page: "insights" };
  if (location.pathname === "/receipts/new") return { page: "new" };
  const match = location.pathname.match(/^\/receipts\/([^/]+)$/);
  return match?.[1] ? { page: "detail", id: match[1] } : { page: "list" };
}

export function navigate(path: string) {
  if (navigationGuard && !navigationGuard()) return;
  navigationGuard = undefined;
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Link({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (!event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {children}
    </a>
  );
}

export function App() {
  const [current, setCurrent] = useState(route);
  useEffect(() => {
    const update = () => {
      if (ignoreNextPop) {
        ignoreNextPop = false;
        setCurrent(route());
        return;
      }
      if (navigationGuard && !navigationGuard()) {
        ignoreNextPop = true;
        history.forward();
        return;
      }
      setCurrent(route());
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    document.title = `${current.page === "list" ? "Ledger" : current.page === "new" ? "New receipt" : current.page === "categories" ? "Categories" : current.page === "category-rules" ? "Category rules" : current.page === "quality" ? "AI quality" : current.page === "insights" ? "Spending insights" : "Receipt detail"} · Receipt Report`;
    const main = document.querySelector("main");
    const heading = document.querySelector<HTMLElement>("main h1");
    if (heading && !main?.contains(document.activeElement)) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [current]);
  return (
    <div className="app">
      <header className="masthead">
        <Link href="/receipts" className="brand">
          <span className="brand-mark">RR</span>
          <span>
            <strong>Receipt Report</strong>
            <small>Private ledger</small>
          </span>
        </Link>
        <nav aria-label="Primary">
          <Link href="/receipts">Ledger</Link>
          <Link href="/insights">Insights</Link>
          <Link href="/categories">Categories</Link>
          <Link href="/category-rules">Rules</Link>
          <Link href="/extraction-quality">AI quality</Link>
          <Link href="/receipts/new" className="button button--small">
            New receipt
          </Link>
        </nav>
      </header>
      <main className="page">
        {current.page === "list" && <ReceiptList key={location.search} />}
        {current.page === "new" && <CreateReceipt />}
        {current.page === "detail" && current.id && (
          <ReceiptEditor id={current.id} />
        )}
        {current.page === "categories" && <CategoryManager />}
        {current.page === "category-rules" && <CategorySuggestionRuleManager />}
        {current.page === "quality" && <ExtractionQuality />}
        {current.page === "insights" && <Insights />}
      </main>
      <footer>Quietly kept on your own server.</footer>
    </div>
  );
}

function ExtractionQuality() {
  const fieldLabel = (value: string) =>
    value
      .replace("lineItem.", "Line · ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const [summary, setSummary] = useState<ReturnType<
    typeof correctionQualitySummarySchema.parse
  > | null>(null);
  const [error, setError] = useState(false);
  const [dateErrors, setDateErrors] = useState<Record<string, string>>({});
  const [filterDraft, setFilterDraft] = useState({
    profileVersion: "",
    provider: "",
    model: "",
    fieldKind: "",
    from: "",
    to: "",
  });
  const [filters, setFilters] = useState(filterDraft);
  useEffect(() => {
    const from = parseDateInput(filters.from, false);
    const to = parseDateInput(filters.to, false);
    const parameters = new URLSearchParams(
      Object.entries({
        ...filters,
        from: from.iso ?? "",
        to: to.iso ?? "",
      }).filter((entry) => entry[1]),
    );
    setError(false);
    void fetch(
      `/api/v1/extraction-quality${parameters.size ? `?${parameters}` : ""}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("quality");
        setSummary(correctionQualitySummarySchema.parse(await response.json()));
      })
      .catch(() => setError(true));
  }, [filters]);
  return (
    <section aria-labelledby="quality-title">
      <p className="eyebrow">Local extraction feedback</p>
      <h1 id="quality-title">AI quality</h1>
      <p>
        Calculated from approved proposal comparisons kept in this database.
        Correction history is never sent to the model provider.
      </p>
      <form
        className="quality-filters panel"
        onSubmit={(event) => {
          event.preventDefault();
          const from = parseDateInput(filterDraft.from, false);
          const to = parseDateInput(filterDraft.to, false);
          const range =
            !from.error && !to.error && from.iso && to.iso
              ? dateRangeError(filterDraft.from, filterDraft.to)
              : null;
          const nextErrors = {
            ...(from.error ? { from: from.error } : {}),
            ...(to.error ? { to: to.error } : {}),
            ...(range ? { to: range } : {}),
          };
          setDateErrors(nextErrors);
          if (Object.keys(nextErrors).length) return;
          setSummary(null);
          setFilters(filterDraft);
        }}
      >
        <strong>Filter feedback</strong>
        {(
          [
            ["profileVersion", "Profile"],
            ["provider", "Provider"],
            ["model", "Model"],
            ["fieldKind", "Field kind"],
          ] as const
        ).map(([name, label]) => (
          <label key={name}>
            <span>{label}</span>
            <input
              value={filterDraft[name]}
              onChange={(event) =>
                setFilterDraft({ ...filterDraft, [name]: event.target.value })
              }
            />
          </label>
        ))}
        {(["from", "to"] as const).map((name) => (
          <DateField
            key={name}
            id={`quality-${name}`}
            label={name === "from" ? "From" : "To"}
            required={false}
            value={filterDraft[name]}
            error={dateErrors[name]}
            className="quality-date-field"
            onChange={(value) =>
              setFilterDraft({ ...filterDraft, [name]: value })
            }
          />
        ))}
        <button className="button button--small" type="submit">
          Apply filters
        </button>
      </form>
      {error && (
        <div className="panel state" role="alert">
          Quality feedback could not be loaded.
        </div>
      )}
      {!summary && !error && (
        <div className="panel state" role="status">
          Calculating feedback…
        </div>
      )}
      {summary && (
        <>
          <div className="quality-summary panel">
            <strong>{summary.totals.proposedFields} proposed fields</strong>
            <span>{summary.totals.changedFields} changed</span>
            <span>{summary.totals.unchangedFields} unchanged</span>
            <span>{summary.totals.missingFilled} missing values filled</span>
            <span>
              {summary.totals.modelValuesRemoved} model values removed
            </span>
            <span>
              {Math.round(summary.totals.correctionRate * 100)}% correction rate
            </span>
          </div>
          <div className="quality-buckets">
            {summary.buckets.map((bucket) => (
              <article
                className="panel"
                key={`${bucket.profileVersion}:${bucket.provider}:${bucket.model}:${bucket.fieldKind}`}
              >
                <h2>{fieldLabel(bucket.fieldKind)}</h2>
                <p>
                  {bucket.provider} · {bucket.model} · {bucket.profileVersion}
                </p>
                <strong>
                  {Math.round(bucket.correctionRate * 100)}% corrected
                </strong>
                <small>
                  {bucket.changedFields} changed of {bucket.proposedFields}
                </small>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function formatDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function ReceiptList() {
  const filters = new URLSearchParams(location.search);
  filters.delete("cursor");
  const filtered = filters.size > 0;
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<
    "loading" | "ready" | "error" | "unavailable"
  >("loading");
  const load = useCallback(async (next?: string) => {
    setState("loading");
    try {
      const parameters = new URLSearchParams(location.search);
      if (next) parameters.set("cursor", next);
      else parameters.delete("cursor");
      const response = await fetch(
        `/api/v1/receipts${parameters.size ? `?${parameters}` : ""}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      const result = receiptListSchema.parse(await response.json());
      setReceipts((existing) =>
        next
          ? [
              ...existing,
              ...result.receipts.filter(
                (item) => !existing.some((old) => old.id === item.id),
              ),
            ]
          : result.receipts,
      );
      setCursor(result.nextCursor);
      setState("ready");
    } catch (error) {
      setState(error instanceof TypeError ? "unavailable" : "error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">Your receipt ledger</p>
          <h1>Purchases, clearly kept.</h1>
          <p>
            Review the everyday details without the noise of a finance
            dashboard.
          </p>
        </div>
        <Link href="/receipts/new" className="button">
          Add a receipt
        </Link>
      </section>
      <section aria-labelledby="ledger-title">
        <div className="section-heading">
          <h2 id="ledger-title">
            {filtered ? "Matching receipts" : "Recent receipts"}
          </h2>
          <span>
            {receipts.length} entries
            {filtered && (
              <>
                {" "}
                · <Link href="/receipts">Clear filters</Link>
              </>
            )}
          </span>
        </div>
        {state === "loading" && receipts.length === 0 && (
          <div className="panel state" role="status">
            Opening your ledger…
          </div>
        )}
        {(state === "error" || state === "unavailable") && (
          <div className="panel state" role="alert">
            <h3>
              {state === "unavailable"
                ? "The local API is unavailable"
                : "The ledger could not be loaded"}
            </h3>
            <p>Your data has not changed. Check the service and try again.</p>
            <button
              className="button button--quiet"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        )}
        {state === "ready" && receipts.length === 0 && (
          <div className="panel empty">
            <span className="empty-icon" aria-hidden="true">
              ⌁
            </span>
            <h3>A fresh page</h3>
            <p>
              Add your first receipt. Manual entry takes only the essential
              details.
            </p>
            <Link href="/receipts/new" className="button">
              Create first receipt
            </Link>
          </div>
        )}
        {receipts.length > 0 && (
          <div className="ledger">
            {receipts.map((receipt) => (
              <Link
                href={`/receipts/${receipt.id}`}
                className="receipt-row"
                key={receipt.id}
              >
                <span>
                  <strong>{receipt.merchantRaw}</strong>
                  <small>
                    {formatDate(receipt.purchaseDate)}
                    {receipt.purchaseTime
                      ? ` · ${receipt.purchaseTime}`
                      : ""} · {receipt.lineItemCount} items
                  </small>
                  <ReceiptLifecycleBadge receiptId={receipt.id} />
                </span>
                <b>{money.format(receipt.totalCents / 100)}</b>
                <span aria-hidden="true">→</span>
              </Link>
            ))}
          </div>
        )}
        {cursor && (
          <div className="load-more">
            <button
              className="button button--quiet"
              disabled={state === "loading"}
              aria-busy={state === "loading"}
              onClick={() => void load(cursor)}
            >
              {state === "loading" ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

export function parseMoney(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:[,.](\d{1,2}))?$/);
  if (!match) return null;
  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function parseSignedMoneyInput(value: string): number | null {
  const match = value.trim().match(/^(-?)(\d+)(?:[,.](\d{1,2}))?$/);
  if (!match) return null;
  const cents =
    Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  const signed = match[1] === "-" ? -cents : cents;
  return Number.isSafeInteger(signed) ? signed : null;
}

export function parseQuantity(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:[,.](\d{1,3}))?$/);
  if (!match) return null;
  const milli =
    Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

function centsInput(value: number | null): string {
  if (value === null) return "";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 100)},${String(absolute % 100).padStart(2, "0")}`;
}

function quantityInput(value: number | null): string {
  if (value === null) return "";
  return (value / 1000)
    .toFixed(3)
    .replace(/\.?0+$/, "")
    .replace(".", ",");
}

export type MerchantIdentityValue = {
  merchantBrandId: string | null;
  merchantStoreId: string | null;
};

export function MerchantIdentity({
  value,
  onChange,
  selectedBrandName,
  selectedStoreName,
}: {
  value: MerchantIdentityValue;
  onChange: (value: MerchantIdentityValue) => void;
  selectedBrandName?: string | undefined;
  selectedStoreName?: string | undefined;
}) {
  const [brands, setBrands] = useState<MerchantBrand[]>([]);
  const [stores, setStores] = useState<MerchantStore[]>([]);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState<"brand" | "store" | null>(null);
  const [createError, setCreateError] = useState("");
  const [brandName, setBrandName] = useState("");
  const [storeDraft, setStoreDraft] = useState({
    name: "",
    street: "",
    postalCode: "",
    city: "",
  });
  const [pendingBrandId, setPendingBrandId] = useState<
    string | null | undefined
  >();

  const loadBrands = useCallback(async () => {
    setLoadError("");
    try {
      const response = await fetch("/api/v1/merchant-brands?limit=100");
      if (!response.ok) throw new Error("load");
      setBrands(merchantBrandListSchema.parse(await response.json()).brands);
    } catch {
      setLoadError("Merchant brands could not be loaded.");
    }
  }, []);

  const loadStores = useCallback(async () => {
    if (!value.merchantBrandId) {
      setStores([]);
      return;
    }
    setLoadError("");
    try {
      const response = await fetch(
        `/api/v1/merchant-stores?brandId=${encodeURIComponent(value.merchantBrandId)}&limit=100`,
      );
      if (!response.ok) throw new Error("load");
      setStores(merchantStoreListSchema.parse(await response.json()).stores);
    } catch {
      setLoadError("Stores could not be loaded.");
    }
  }, [value.merchantBrandId]);
  useEffect(() => void loadStores(), [loadStores]);

  const chooseBrand = (brandId: string | null) => {
    if (value.merchantStoreId && brandId !== value.merchantBrandId) {
      setPendingBrandId(brandId);
      return;
    }
    onChange({ merchantBrandId: brandId, merchantStoreId: null });
  };

  async function createBrand() {
    const name = brandName.trim();
    if (!name) return setCreateError("Enter a brand name.");
    setCreateError("");
    const response = await fetch("/api/v1/merchant-brands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!response) {
      setCreateError(
        "The brand could not be created. Your receipt edits are unchanged; try again.",
      );
      return;
    }
    if (response.ok) {
      const brand = merchantBrandSchema.parse(await response.json());
      setBrands((current) =>
        [...current, brand].sort((a, b) => a.name.localeCompare(b.name, "de")),
      );
      onChange({ merchantBrandId: brand.id, merchantStoreId: null });
      setCreating(null);
      return;
    }
    const error = apiErrorSchema.safeParse(await response.json());
    if (error.success && error.data.error.code === "conflict") {
      const existingResponse = await fetch(
        `/api/v1/merchant-brands?query=${encodeURIComponent(name)}&limit=100`,
      ).catch(() => null);
      const existing = existingResponse?.ok
        ? merchantBrandListSchema
            .parse(await existingResponse.json())
            .brands.find(
              (brand) =>
                normalizeMerchantName(brand.name) ===
                normalizeMerchantName(name),
            )
        : undefined;
      if (existing) {
        setBrands((current) =>
          current.some((brand) => brand.id === existing.id)
            ? current
            : [...current, existing],
        );
        onChange({ merchantBrandId: existing.id, merchantStoreId: null });
        setCreateError("That brand already exists; it has been selected.");
        setCreating(null);
        return;
      }
    }
    setCreateError(
      "The brand could not be created. Your receipt edits are unchanged; try again.",
    );
  }

  async function createStore() {
    if (!value.merchantBrandId) return;
    const body = {
      brandId: value.merchantBrandId,
      name: storeDraft.name,
      street: storeDraft.street || null,
      postalCode: storeDraft.postalCode || null,
      city: storeDraft.city || null,
    };
    if (!body.name.trim()) return setCreateError("Enter a store name.");
    setCreateError("");
    const response = await fetch("/api/v1/merchant-stores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!response) {
      setCreateError(
        "The store could not be created. Your receipt edits are unchanged; try again.",
      );
      return;
    }
    if (response.ok) {
      const store = merchantStoreSchema.parse(await response.json());
      setStores((current) =>
        [...current, store].sort((a, b) => a.name.localeCompare(b.name, "de")),
      );
      onChange({ merchantBrandId: store.brandId, merchantStoreId: store.id });
      setCreating(null);
      return;
    }
    const error = apiErrorSchema.safeParse(await response.json());
    if (error.success && error.data.error.code === "conflict") {
      const existingResponse = await fetch(
        `/api/v1/merchant-stores?brandId=${encodeURIComponent(value.merchantBrandId)}&query=${encodeURIComponent(body.name)}&limit=100`,
      ).catch(() => null);
      const existing = existingResponse?.ok
        ? merchantStoreListSchema
            .parse(await existingResponse.json())
            .stores.find(
              (store) =>
                normalizeMerchantName(store.name) ===
                  normalizeMerchantName(body.name) &&
                store.normalizedAddressKey ===
                  normalizeMerchantAddressKey(body),
            )
        : undefined;
      if (existing) {
        setStores((current) =>
          current.some((store) => store.id === existing.id)
            ? current
            : [...current, existing],
        );
        onChange({
          merchantBrandId: existing.brandId,
          merchantStoreId: existing.id,
        });
        setCreateError(
          "That exact store already exists; it has been selected.",
        );
        setCreating(null);
        return;
      }
    }
    setCreateError(
      "The store could not be created. Your receipt edits are unchanged; try again.",
    );
  }

  return (
    <fieldset className="merchant-identity field--wide">
      <legend>
        Canonical merchant identity <span>optional</span>
      </legend>
      <p id="merchant-identity-help">
        Keep the printed merchant above; optionally group it by brand and store.
      </p>
      {loadError && (
        <div className="inline-error" role="alert">
          {loadError}{" "}
          <button
            type="button"
            onClick={() =>
              void (value.merchantBrandId ? loadStores() : loadBrands())
            }
          >
            Try again
          </button>
        </div>
      )}
      <div className="merchant-selects">
        <div className="field">
          <label htmlFor="merchant-brand">Brand</label>
          <select
            id="merchant-brand"
            aria-describedby="merchant-identity-help"
            value={value.merchantBrandId ?? ""}
            onFocus={() => void loadBrands()}
            onChange={(event) => chooseBrand(event.target.value || null)}
          >
            <option value="">Unassigned</option>
            {value.merchantBrandId &&
              !brands.some((brand) => brand.id === value.merchantBrandId) && (
                <option value={value.merchantBrandId}>
                  {selectedBrandName ?? "Assigned brand"}
                </option>
              )}
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="merchant-store">Store</label>
          <select
            id="merchant-store"
            disabled={!value.merchantBrandId}
            aria-describedby="merchant-identity-help"
            value={value.merchantStoreId ?? ""}
            onChange={(event) =>
              onChange({
                merchantBrandId: value.merchantBrandId,
                merchantStoreId: event.target.value || null,
              })
            }
          >
            <option value="">Unassigned</option>
            {value.merchantStoreId &&
              !stores.some((store) => store.id === value.merchantStoreId) && (
                <option value={value.merchantStoreId}>
                  {selectedStoreName ?? "Assigned store"}
                </option>
              )}
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {pendingBrandId !== undefined && (
        <div
          className="inline-confirmation"
          role="alertdialog"
          aria-labelledby="merchant-change-title"
        >
          <strong id="merchant-change-title">Clear the selected store?</strong>
          <p>
            Changing or clearing its brand also clears the store assignment.
          </p>
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              onChange({
                merchantBrandId: pendingBrandId,
                merchantStoreId: null,
              });
              setPendingBrandId(undefined);
            }}
          >
            Continue
          </button>
          <button
            type="button"
            className="button button--small button--quiet"
            onClick={() => setPendingBrandId(undefined)}
          >
            Cancel
          </button>
        </div>
      )}
      <div className="merchant-create-actions">
        <button
          type="button"
          onClick={() => {
            setCreating(creating === "brand" ? null : "brand");
            setCreateError("");
          }}
        >
          + Create brand
        </button>
        <button
          type="button"
          disabled={!value.merchantBrandId}
          onClick={() => {
            setCreating(creating === "store" ? null : "store");
            setCreateError("");
          }}
        >
          + Create store
        </button>
      </div>
      {creating === "brand" && (
        <div className="inline-create">
          <div className="field">
            <label htmlFor="new-brand-name">Brand name</label>
            <input
              id="new-brand-name"
              value={brandName}
              onChange={(event) => setBrandName(event.target.value)}
              autoFocus
            />
          </div>
          <button
            type="button"
            className="button button--small"
            onClick={() => void createBrand()}
          >
            Create and select
          </button>
        </div>
      )}
      {creating === "store" && (
        <div className="inline-create">
          <div className="field">
            <label htmlFor="new-store-name">Store name</label>
            <input
              id="new-store-name"
              value={storeDraft.name}
              onChange={(event) =>
                setStoreDraft((draft) => ({
                  ...draft,
                  name: event.target.value,
                }))
              }
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="new-store-street">
              Street <span>optional</span>
            </label>
            <input
              id="new-store-street"
              value={storeDraft.street}
              onChange={(event) =>
                setStoreDraft((draft) => ({
                  ...draft,
                  street: event.target.value,
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="new-store-postal">
              Postal code <span>optional</span>
            </label>
            <input
              id="new-store-postal"
              value={storeDraft.postalCode}
              onChange={(event) =>
                setStoreDraft((draft) => ({
                  ...draft,
                  postalCode: event.target.value,
                }))
              }
            />
          </div>
          <div className="field">
            <label htmlFor="new-store-city">
              City <span>optional</span>
            </label>
            <input
              id="new-store-city"
              value={storeDraft.city}
              onChange={(event) =>
                setStoreDraft((draft) => ({
                  ...draft,
                  city: event.target.value,
                }))
              }
            />
          </div>
          <button
            type="button"
            className="button button--small"
            onClick={() => void createStore()}
          >
            Create and select
          </button>
        </div>
      )}
      {createError && (
        <p className="field-error" role="status">
          {createError}
        </p>
      )}
    </fieldset>
  );
}

function CreateReceipt() {
  const [submitting, setSubmitting] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [createdReceiptId, setCreatedReceiptId] = useState<string>();
  const [duplicateReceiptId, setDuplicateReceiptId] = useState<string>();
  const [merchantRaw, setMerchantRaw] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [purchaseTime, setPurchaseTime] = useState("");
  const [totalInput, setTotalInput] = useState("");
  const [notes, setNotes] = useState("");
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const [merchantIdentity, setMerchantIdentity] =
    useState<MerchantIdentityValue>({
      merchantBrandId: null,
      merchantStoreId: null,
    });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedMerchant = merchantRaw.trim();
    const total = parseMoney(totalInput);
    const next: Record<string, string> = {};
    if (!manualEntry && !documentFile)
      next.document = "Choose a receipt image or PDF.";
    if (manualEntry) {
      const parsedDate = parseDateInput(purchaseDate);
      if (!normalizedMerchant) next.merchantRaw = "Enter a merchant.";
      if (parsedDate.error) next.purchaseDate = parsedDate.error;
      if (total === null)
        next.total = "Enter euros with up to two decimal places.";
    }
    setErrors(next);
    if (Object.keys(next).length) {
      document.querySelector<HTMLElement>(".validation-summary")?.focus();
      return;
    }
    setSubmitting(true);
    setServerError("");
    try {
      const body = {
        merchantRaw: manualEntry
          ? normalizedMerchant
          : UPLOAD_PLACEHOLDER_RECEIPT.merchantRaw,
        ...(manualEntry
          ? merchantIdentity
          : { merchantBrandId: null, merchantStoreId: null }),
        purchaseDate: manualEntry
          ? (parseDateInput(purchaseDate).iso ?? "")
          : new Date().toISOString().slice(0, 10),
        purchaseTime: manualEntry ? purchaseTime || null : null,
        totalCents: manualEntry ? total : UPLOAD_PLACEHOLDER_RECEIPT.totalCents,
        notes: manualEntry ? notes || null : null,
      };
      let receiptId = createdReceiptId;
      let createdForUpload = false;
      if (!receiptId) {
        const response = await fetch("/api/v1/receipts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const parsed = apiErrorSchema.safeParse(await response.json());
          setServerError(
            parsed.success && parsed.data.error.code === "validation_error"
              ? "Please check the entered values."
              : "The receipt may not have been saved. Check the ledger before retrying.",
          );
          return;
        }
        const created = receiptDetailSchema.safeParse(await response.json());
        if (!created.success) {
          setServerError(
            "The receipt may have been saved, but confirmation was incomplete. Check the ledger before retrying.",
          );
          return;
        }
        receiptId = created.data.id;
        setCreatedReceiptId(receiptId);
        createdForUpload = !manualEntry;
      }
      if (documentFile) {
        const controller = new AbortController();
        uploadAbort.current = controller;
        try {
          await uploadReceiptDocument(
            receiptId,
            documentFile,
            false,
            controller.signal,
          );
        } catch (error) {
          if (!(error instanceof DocumentUploadError)) {
            const confirmation = await fetch(
              `/api/v1/receipts/${receiptId}/document`,
            ).catch(() => null);
            if (confirmation?.ok) {
              const parsed = receiptDocumentResponseSchema.safeParse(
                await confirmation.json().catch(() => null),
              );
              if (parsed.success) {
                navigate(`/receipts/${receiptId}`);
                return;
              }
            }
          }
          const definitive =
            error instanceof DocumentUploadError &&
            [
              "unsupported_document",
              "document_too_large",
              "malformed_document",
              "duplicate_document",
              "multipart_error",
              "cancelled",
            ].includes(error.code);
          if (createdForUpload && definitive) {
            const removed = await fetch(`/api/v1/receipts/${receiptId}`, {
              method: "DELETE",
            }).catch(() => null);
            if (removed?.ok) {
              setCreatedReceiptId(undefined);
              setServerError(failureMessage(error));
              if (error instanceof DocumentUploadError)
                setDuplicateReceiptId(error.duplicateReceiptId);
              return;
            }
          }
          setServerError(`Receipt saved. ${failureMessage(error)}`);
          if (error instanceof DocumentUploadError)
            setDuplicateReceiptId(error.duplicateReceiptId);
          return;
        } finally {
          uploadAbort.current = undefined;
        }
      }
      navigate(`/receipts/${receiptId}`);
    } catch {
      setServerError(
        "The receipt may not have been saved. Check the ledger before retrying.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="form-page">
      <div className="breadcrumb">
        <Link href="/receipts">← Ledger</Link>
      </div>
      <p className="eyebrow">AI-assisted capture</p>
      <h1>New receipt</h1>
      <p className="intro">
        Upload a receipt image or PDF. AI will extract the merchant, date,
        total, and line items for you to review.
      </p>
      {Object.keys(errors).length > 0 && (
        <div
          className="banner banner--error validation-summary"
          role="alert"
          tabIndex={-1}
        >
          <strong>Please review the highlighted fields.</strong>
        </div>
      )}
      {serverError && (
        <div className="banner banner--error" role="alert">
          {serverError}{" "}
          {createdReceiptId && (
            <a href={`/receipts/${createdReceiptId}`}>Open the saved receipt</a>
          )}{" "}
          {duplicateReceiptId && (
            <a href={`/receipts/${duplicateReceiptId}`}>
              Open the existing receipt
            </a>
          )}
        </div>
      )}
      <form
        className="panel receipt-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <div className="field field--wide">
          <span className="field-label">
            Receipt document {!manualEntry && <span>required</span>}
          </span>
          <DocumentFileField
            id="new-receipt-document"
            file={documentFile}
            disabled={submitting}
            required={!manualEntry}
            invalid={!!errors.document}
            describedBy={
              errors.document ? "new-receipt-document-error" : undefined
            }
            onFile={(file) => {
              setDocumentFile(file);
              if (file)
                setErrors((current) => {
                  const next = { ...current };
                  delete next.document;
                  return next;
                });
            }}
            onError={setServerError}
          />
          {errors.document && (
            <small id="new-receipt-document-error" className="field-error">
              {errors.document}
            </small>
          )}
        </div>
        {!manualEntry && (
          <div className="field field--wide">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setManualEntry(true)}
            >
              Enter receipt manually instead
            </button>
          </div>
        )}
        {manualEntry && (
          <>
            <div className="field field--wide">
              <label htmlFor="merchantRaw">Merchant</label>
              <input
                id="merchantRaw"
                name="merchantRaw"
                autoFocus
                value={merchantRaw}
                onChange={(event) => setMerchantRaw(event.target.value)}
                aria-invalid={!!errors.merchantRaw}
                aria-describedby={
                  errors.merchantRaw ? "merchantRaw-error" : undefined
                }
              />
              {errors.merchantRaw && (
                <small id="merchantRaw-error" className="field-error">
                  {errors.merchantRaw}
                </small>
              )}
            </div>
            <MerchantIdentity
              value={merchantIdentity}
              onChange={setMerchantIdentity}
            />
            <DateField
              id="purchaseDate"
              label="Purchase date"
              value={purchaseDate}
              error={errors.purchaseDate}
              onChange={setPurchaseDate}
            />
            <div className="field">
              <label htmlFor="purchaseTime">
                Time <span>optional</span>
              </label>
              <input
                id="purchaseTime"
                name="purchaseTime"
                type="time"
                value={purchaseTime}
                onChange={(event) => setPurchaseTime(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="total">Total</label>
              <div className="money-input">
                <span>€</span>
                <input
                  id="total"
                  name="total"
                  inputMode="decimal"
                  placeholder="0,00"
                  value={totalInput}
                  onChange={(event) => setTotalInput(event.target.value)}
                  aria-invalid={!!errors.total}
                  aria-describedby={errors.total ? "total-error" : undefined}
                />
              </div>
              {errors.total && (
                <small id="total-error" className="field-error">
                  {errors.total}
                </small>
              )}
            </div>
            <div className="field field--wide">
              <label htmlFor="notes">
                Notes <span>optional</span>
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={4}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            <div className="field field--wide">
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setManualEntry(false)}
              >
                Use AI upload only
              </button>
            </div>
          </>
        )}
        {submitting && documentFile && createdReceiptId && (
          <div className="field field--wide upload-progress">
            <progress aria-label="Uploading document" />
            <button
              type="button"
              className="button button--quiet"
              onClick={() => uploadAbort.current?.abort()}
            >
              Cancel upload
            </button>
          </div>
        )}
        <div className="form-actions">
          <Link href="/receipts" className="button button--quiet">
            Cancel
          </Link>
          <button
            className="button"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting
              ? createdReceiptId
                ? "Uploading…"
                : "Saving…"
              : createdReceiptId
                ? "Retry upload"
                : manualEntry
                  ? "Save receipt"
                  : "Upload receipt"}
          </button>
        </div>
      </form>
    </section>
  );
}

type EditorItem = {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  categoryId?: string | null;
  kind: ReceiptDetail["lineItems"][number]["kind"];
};
type EditorValues = {
  merchantRaw: string;
  merchantBrandId: string | null;
  merchantStoreId: string | null;
  merchantBrandName: string;
  merchantStoreName: string;
  purchaseDate: string;
  purchaseTime: string;
  total: string;
  taxCents: number | null;
  notes: string;
  items: EditorItem[];
};

function editorValues(receipt: ReceiptDetail): EditorValues {
  return {
    merchantRaw: receipt.merchantRaw,
    merchantBrandId: receipt.merchantBrand?.id ?? null,
    merchantStoreId: receipt.merchantStore?.id ?? null,
    merchantBrandName: receipt.merchantBrand?.name ?? "",
    merchantStoreName: receipt.merchantStore?.name ?? "",
    purchaseDate: displayDate(receipt.purchaseDate),
    purchaseTime: receipt.purchaseTime ?? "",
    total: centsInput(receipt.totalCents),
    taxCents: receipt.taxCents,
    notes: receipt.notes ?? "",
    items: receipt.lineItems.map((item) => ({
      key: item.id,
      description: item.description,
      quantity: quantityInput(item.quantityMilli ?? null),
      unitPrice: centsInput(item.unitPriceCents ?? null),
      lineTotal: centsInput(item.lineTotalCents),
      categoryId: item.categoryId,
      kind: item.kind,
    })),
  };
}

export function lineTotalSum<V extends { items: { lineTotal: string }[] }>(
  values: V,
): number | null {
  let total = 0;
  for (const item of values.items) {
    const cents = parseSignedMoneyInput(item.lineTotal);
    if (cents === null) return null;
    total += cents;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function receiptComposition(
  values: Pick<EditorValues, "items" | "total">,
  categories: Category[],
): CompositionBucket[] {
  const totals = new Map<string, CompositionBucket>();
  for (const item of values.items) {
    const cents = parseSignedMoneyInput(item.lineTotal);
    if (cents === null) continue;
    const category = categories.find((entry) => entry.id === item.categoryId);
    const key = category?.id ?? "uncategorized";
    const current = totals.get(key);
    totals.set(key, {
      key,
      label: category ? categoryLabel(category, categories) : "Uncategorized",
      signedCents: (current?.signedCents ?? 0) + cents,
    });
  }
  const enteredTotal = parseMoney(values.total);
  const lineSum = lineTotalSum(values);
  if (enteredTotal !== null && lineSum !== null && enteredTotal !== lineSum)
    totals.set("unallocated-adjustment", {
      key: "unallocated-adjustment",
      label: "Unallocated adjustment",
      signedCents: enteredTotal - lineSum,
    });
  return [...totals.values()];
}

export function CategorySuggestionAdvice({
  description,
  categoryId,
  brandId,
  storeId,
  categories,
  onAdopt,
  onStatus,
  onActionable,
}: {
  description: string;
  categoryId: string | null;
  brandId: string | null;
  storeId: string | null;
  categories: Category[];
  onAdopt: (categoryId: string) => void;
  onStatus: (message: string) => void;
  onActionable?: () => void;
}) {
  const [suggestion, setSuggestion] = useState<CategorySuggestionRule | null>(
    null,
  );
  const [scope, setScope] = useState<"global" | "brand" | "store">("global");
  const [remembering, setRemembering] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const trimmed = description.trim();
    if (!trimmed || categoryId) {
      setSuggestion(null);
      return () => controller.abort();
    }
    const parameters = new URLSearchParams({ description: trimmed });
    if (brandId) parameters.set("brandId", brandId);
    if (storeId) parameters.set("storeId", storeId);
    void fetch(`/api/v1/category-suggestion-rules/suggestion?${parameters}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("suggestion");
        return categorySuggestionSchema.parse(await response.json()).suggestion;
      })
      .then(setSuggestion)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setSuggestion(null);
        }
      });
    return () => controller.abort();
  }, [description, categoryId, brandId, storeId]);
  useEffect(() => {
    if (suggestion && !categoryId) onActionable?.();
  }, [suggestion, categoryId, onActionable]);
  useEffect(() => {
    if (!brandId) setScope("global");
    else if (!storeId && scope === "store") setScope("brand");
  }, [brandId, storeId, scope]);

  async function remember() {
    if (!categoryId) return;
    setRemembering(true);
    try {
      const result = await rememberCategoryRule({
        description,
        categoryId,
        scopeKind: scope,
        brandId: scope === "global" ? null : brandId,
        storeId: scope === "store" ? storeId : null,
      });
      onStatus(
        result === "created"
          ? "Rule remembered for future receipts."
          : result === "replaced"
            ? "Existing rule replaced after confirmation."
            : "Existing rule left unchanged.",
      );
    } catch {
      onStatus("The rule could not be remembered. Your receipt is unchanged.");
    } finally {
      setRemembering(false);
    }
  }

  if (suggestion && !categoryId) {
    return (
      <div className="suggestion-advice">
        <span>
          Suggested: {categoryLabel(suggestion.category, categories)} ·{" "}
          {suggestion.scopeKind === "global"
            ? "global"
            : suggestion.scopeKind === "brand"
              ? `brand ${suggestion.brand?.name ?? ""}`
              : `store ${suggestion.store?.name ?? ""}`}
        </span>
        <button
          type="button"
          className="button button--quiet button--small"
          onClick={() => onAdopt(suggestion.categoryId)}
        >
          Adopt suggestion
        </button>
      </div>
    );
  }
  if (!categoryId || !description.trim()) return null;
  return (
    <div className="suggestion-advice">
      <label>
        Remember for future{" "}
        <select
          aria-label={`Remember scope for ${description}`}
          value={scope}
          onChange={(event) =>
            setScope(event.target.value as "global" | "brand" | "store")
          }
        >
          <option value="global">Globally</option>
          {brandId && <option value="brand">For this brand</option>}
          {storeId && <option value="store">For this store</option>}
        </select>
      </label>
      <button
        type="button"
        className="button button--quiet button--small"
        disabled={remembering}
        onClick={() => void remember()}
      >
        {remembering ? "Remembering…" : "Remember"}
      </button>
    </div>
  );
}

function ReceiptEditor({ id }: { id: string }) {
  const [loadState, setLoadState] = useState<
    "loading" | "ready" | "not-found" | "error"
  >("loading");
  const empty: EditorValues = {
    merchantRaw: "",
    merchantBrandId: null,
    merchantStoreId: null,
    merchantBrandName: "",
    merchantStoreName: "",
    purchaseDate: "",
    purchaseTime: "",
    total: "",
    taxCents: null,
    notes: "",
    items: [],
  };
  const [values, setValues] = useState<EditorValues>(empty);
  const [saved, setSaved] = useState<EditorValues>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [receiptUpdatedAt, setReceiptUpdatedAt] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryError, setCategoryError] = useState("");
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkCategoryChosen, setBulkCategoryChosen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const userToggledItems = useRef<Set<string>>(new Set());
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const response = await fetch(`/api/v1/receipts/${id}`);
      if (response.status === 404) {
        setLoadState("not-found");
        return;
      }
      if (!response.ok) throw new Error("load");
      const parsed = receiptDetailSchema.parse(await response.json());
      const next = editorValues(parsed);
      setValues(next);
      setSaved(next);
      setReceiptUpdatedAt(parsed.updatedAt);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const refreshCategories = useCallback(async () => {
    try {
      setCategories(await loadCategories());
      setCategoryError("");
    } catch {
      setCategoryError(
        "Categories could not be loaded. Existing receipt edits are unchanged.",
      );
    }
  }, []);
  useEffect(() => void refreshCategories(), [refreshCategories]);
  useEffect(() => {
    navigationGuard = dirty
      ? () => window.confirm("Discard your unsaved changes?")
      : undefined;
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      navigationGuard = undefined;
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);
  if (loadState === "loading")
    return (
      <div className="panel state" role="status">
        Loading receipt…
      </div>
    );
  if (loadState === "not-found")
    return (
      <div className="panel state">
        <h1>Receipt not found</h1>
        <p>It may already have been deleted.</p>
        <Link href="/receipts" className="button">
          Back to ledger
        </Link>
      </div>
    );
  if (loadState === "error")
    return (
      <div className="panel state" role="alert">
        <h1>Could not open receipt</h1>
        <button className="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  const update = <K extends keyof EditorValues>(
    key: K,
    value: EditorValues[K],
  ) => setValues((current) => ({ ...current, [key]: value }));
  const updateItem = (
    index: number,
    field: keyof Omit<EditorItem, "key">,
    value: string | null,
  ) =>
    update(
      "items",
      values.items.map((item, at) =>
        at === index ? { ...item, [field]: value } : item,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= values.items.length) return;
    const items = [...values.items];
    const [item] = items.splice(index, 1);
    if (!item) return;
    items.splice(target, 0, item);
    update("items", items);
    requestAnimationFrame(() =>
      document.getElementById(`item-${item.key}-description`)?.focus(),
    );
  };
  const remove = (index: number) => {
    const removedKey = values.items[index]?.key;
    const items = values.items.filter((_item, at) => at !== index);
    update("items", items);
    if (removedKey) {
      setExpandedItems((current) => {
        const next = new Set(current);
        next.delete(removedKey);
        return next;
      });
      userToggledItems.current.delete(removedKey);
    }
    requestAnimationFrame(() =>
      document
        .getElementById(
          items[Math.min(index, items.length - 1)]
            ? `item-${items[Math.min(index, items.length - 1)]?.key}-description`
            : "add-item",
        )
        ?.focus(),
    );
  };
  const add = () => {
    const key = `new-${crypto.randomUUID()}`;
    update("items", [
      ...values.items,
      {
        key,
        description: "",
        quantity: "",
        unitPrice: "",
        lineTotal: "",
        categoryId: null,
        kind: "item",
      },
    ]);
    requestAnimationFrame(() =>
      document.getElementById(`item-${key}-description`)?.focus(),
    );
  };
  async function save() {
    const nextErrors: Record<string, string> = {};
    const total = parseMoney(values.total);
    const purchaseDate = parseDateInput(values.purchaseDate);
    if (!values.merchantRaw.trim())
      nextErrors.merchantRaw = "Enter a merchant.";
    if (purchaseDate.error) nextErrors.purchaseDate = purchaseDate.error;
    if (!total && total !== 0)
      nextErrors.total = "Enter a valid non-negative EUR amount.";
    const lineItems = values.items.map((item, index) => {
      const lineTotal = parseSignedMoneyInput(item.lineTotal);
      const quantity = item.quantity ? parseQuantity(item.quantity) : null;
      const unitPrice = item.unitPrice
        ? parseSignedMoneyInput(item.unitPrice)
        : null;
      if (!item.description.trim())
        nextErrors[`item-${index}-description`] = "Enter a description.";
      if (lineTotal === null)
        nextErrors[`item-${index}-lineTotal`] = "Enter a valid amount.";
      if (item.quantity && quantity === null)
        nextErrors[`item-${index}-quantity`] =
          "Use a positive quantity with up to three decimals.";
      if (item.unitPrice && unitPrice === null)
        nextErrors[`item-${index}-unitPrice`] = "Enter a valid amount.";
      return {
        ...(item.key.startsWith("new-") ? {} : { id: item.key }),
        description: item.description.trim(),
        quantityMilli: quantity,
        unitPriceCents: unitPrice,
        lineTotalCents: lineTotal ?? 0,
        categoryId: item.categoryId ?? null,
        kind: item.kind,
      };
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || total === null) {
      setStatus("Please correct the highlighted fields.");
      return;
    }
    setSaving(true);
    setStatus("Saving…");
    try {
      const response = await fetch(`/api/v1/receipts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchantRaw: values.merchantRaw,
          merchantBrandId: values.merchantBrandId,
          merchantStoreId: values.merchantStoreId,
          purchaseDate: purchaseDate.iso,
          purchaseTime: values.purchaseTime || null,
          totalCents: total,
          notes: values.notes || null,
          lineItems,
        }),
      });
      if (!response.ok) throw new Error("save");
      const parsed = receiptDetailSchema.parse(await response.json());
      const next = editorValues(parsed);
      setValues(next);
      setSaved(next);
      setReceiptUpdatedAt(parsed.updatedAt);
      setStatus("Receipt saved.");
    } catch {
      setStatus("Could not save. Your changes are still here; try again.");
    } finally {
      setSaving(false);
    }
  }
  async function deleteReceipt() {
    if (!window.confirm("Delete this receipt permanently?")) return;
    try {
      const response = await fetch(`/api/v1/receipts/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("delete");
      setSaved(values);
      navigationGuard = undefined;
      navigate("/receipts");
    } catch {
      setStatus(
        "Could not delete the receipt. Nothing was removed; try again.",
      );
    }
  }
  async function createCategory() {
    const name = newCategoryName.trim();
    if (!name) {
      setCategoryError("Enter a category name.");
      return;
    }
    setCreatingCategory(true);
    setCategoryError("");
    try {
      const response = await fetch("/api/v1/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          parentId: newCategoryParentId || null,
        }),
      });
      if (!response.ok) throw new Error("create");
      const created = categorySchema.parse(await response.json());
      await refreshCategories();
      setNewCategoryName("");
      setNewCategoryParentId("");
      if (created.isAssignable) {
        setBulkCategoryId(created.id);
        setBulkCategoryChosen(true);
      }
      setStatus(
        "Category created independently; your receipt edits are unchanged.",
      );
    } catch {
      setCategoryError(
        "The category could not be created. Your receipt edits are unchanged; try again.",
      );
    } finally {
      setCreatingCategory(false);
    }
  }
  function applyBulkCategory() {
    setValues((current) => ({
      ...current,
      items: current.items.map((item) =>
        selectedItems.has(item.key)
          ? { ...item, categoryId: bulkCategoryId || null }
          : item,
      ),
    }));
    setStatus(
      `Updated ${selectedItems.size} selected ${selectedItems.size === 1 ? "item" : "items"} locally. Save the receipt to keep the change.`,
    );
  }
  const sum = lineTotalSum(values);
  const enteredTotal = parseMoney(values.total);
  const discrepancy =
    sum !== null && enteredTotal !== null && sum !== enteredTotal;
  const ordinaryItems = values.items.filter((item) =>
    ["item", "unknown"].includes(item.kind),
  );
  const categorizedItems = ordinaryItems.filter((item) => item.categoryId);
  const coverage = ordinaryItems.length
    ? Math.round((categorizedItems.length / ordinaryItems.length) * 100)
    : null;
  const specialKinds = [
    ["discount", "discount"],
    ["return", "return"],
    ["deposit", "deposit"],
    ["deposit_refund", "deposit refund"],
  ] as const;
  const specialSummary = specialKinds
    .map(([kind, label]) => {
      const count = values.items.filter((item) => item.kind === kind).length;
      return count ? `${count} ${label}${count === 1 ? "" : "s"}` : null;
    })
    .filter((value): value is string => value !== null)
    .join(" · ");
  const composition = receiptComposition(values, categories);
  return (
    <section className="editor">
      <div className="breadcrumb">
        <Link href="/receipts">← Ledger</Link>
      </div>
      <div className="editor-heading">
        <div>
          <p className="eyebrow">Receipt detail</p>
          <h1>Edit receipt</h1>
        </div>
        <div className="editor-actions">
          <button
            className="button button--quiet danger"
            onClick={() => void deleteReceipt()}
          >
            Delete
          </button>
          <button
            className="button"
            disabled={saving || !dirty}
            aria-busy={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
      <section
        className="receipt-summary-strip panel"
        aria-label="Receipt summary"
      >
        <div>
          <span>Receipt total</span>
          <strong>
            {enteredTotal === null
              ? "Not available"
              : money.format(enteredTotal / 100)}
          </strong>
        </div>
        <div>
          <span>Line items</span>
          <strong>{values.items.length}</strong>
          {specialSummary && <small>{specialSummary}</small>}
        </div>
        <div>
          <span>Tax</span>
          <strong>
            {values.taxCents === null
              ? "Not available"
              : money.format(values.taxCents / 100)}
          </strong>
        </div>
        <div>
          <span>Categorized coverage</span>
          <strong>
            {coverage === null ? "Not available" : `${coverage}%`}
          </strong>
          <small>
            {ordinaryItems.length
              ? `${categorizedItems.length} of ${ordinaryItems.length} item rows`
              : "No item rows"}
          </small>
        </div>
      </section>
      <div className="editor-grid">
        <div>
          <section
            className="panel receipt-form editor-fields"
            aria-labelledby="details-heading"
          >
            <h2 id="details-heading" className="field--wide">
              Receipt details
            </h2>
            <EditorField
              label="Merchant"
              id="editor-merchantRaw"
              value={values.merchantRaw}
              error={errors.merchantRaw}
              onChange={(value) => update("merchantRaw", value)}
            />
            <MerchantIdentity
              value={{
                merchantBrandId: values.merchantBrandId,
                merchantStoreId: values.merchantStoreId,
              }}
              onChange={(identity) =>
                setValues((current) => ({ ...current, ...identity }))
              }
              selectedBrandName={values.merchantBrandName}
              selectedStoreName={values.merchantStoreName}
            />
            <DateField
              label="Purchase date"
              id="editor-date"
              value={values.purchaseDate}
              error={errors.purchaseDate}
              onChange={(value) => update("purchaseDate", value)}
            />
            <EditorField
              label="Time"
              id="editor-time"
              type="time"
              value={values.purchaseTime}
              onChange={(value) => update("purchaseTime", value)}
            />
            <EditorField
              label="Receipt total"
              id="editor-total"
              value={values.total}
              error={errors.total}
              inputMode="decimal"
              onChange={(value) => update("total", value)}
            />
            <div className="field field--wide">
              <label htmlFor="editor-notes">Notes</label>
              <textarea
                id="editor-notes"
                rows={3}
                value={values.notes}
                onChange={(event) => update("notes", event.target.value)}
              />
            </div>
          </section>
          <section className="items" aria-labelledby="items-heading">
            <div className="section-heading">
              <h2 id="items-heading">Line items</h2>
              <button
                id="add-item"
                className="button button--quiet"
                onClick={add}
              >
                + Add item
              </button>
            </div>
            {categoryError && (
              <div className="inline-error" role="alert">
                {categoryError}{" "}
                <button type="button" onClick={() => void refreshCategories()}>
                  Try again
                </button>
              </div>
            )}
            <div className="panel category-tools">
              <div className="bulk-category">
                <label htmlFor="bulk-category">
                  Category for selected items
                </label>
                <select
                  id="bulk-category"
                  value={bulkCategoryId}
                  onChange={(event) => {
                    setBulkCategoryId(event.target.value);
                    setBulkCategoryChosen(true);
                  }}
                >
                  {!bulkCategoryChosen && (
                    <option value="" disabled>
                      Choose a category…
                    </option>
                  )}
                  <CategoryOptions
                    categories={categories}
                    value={bulkCategoryId || null}
                  />
                </select>
                <button
                  type="button"
                  className="button button--small"
                  disabled={selectedItems.size === 0 || !bulkCategoryChosen}
                  onClick={applyBulkCategory}
                >
                  Apply to {selectedItems.size || "selected"}
                </button>
              </div>
              <details>
                <summary>
                  Create a category without losing receipt edits
                </summary>
                <div className="inline-create">
                  <div className="field">
                    <label htmlFor="receipt-new-category">Name</label>
                    <input
                      id="receipt-new-category"
                      value={newCategoryName}
                      onChange={(event) =>
                        setNewCategoryName(event.target.value)
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="receipt-new-category-parent">Parent</label>
                    <select
                      id="receipt-new-category-parent"
                      value={newCategoryParentId}
                      onChange={(event) =>
                        setNewCategoryParentId(event.target.value)
                      }
                    >
                      <option value="">Top level</option>
                      {categories
                        .filter(
                          ({ parentId, archivedAt }) =>
                            parentId === null && !archivedAt,
                        )
                        .map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="button button--small"
                    disabled={creatingCategory}
                    onClick={() => void createCategory()}
                  >
                    {creatingCategory ? "Creating…" : "Create category"}
                  </button>
                </div>
              </details>
            </div>
            {values.items.length === 0 && (
              <div className="panel state">
                <p>No line items yet.</p>
              </div>
            )}
            {values.items.length > 0 && (
              <div
                className="line-table panel"
                role="table"
                aria-label="Receipt line items"
              >
                <div className="line-table__header" role="rowgroup">
                  <div role="row" className="line-row line-row--header">
                    <span role="columnheader" aria-label="Select" />
                    <span role="columnheader">Description</span>
                    <span role="columnheader">Quantity</span>
                    <span role="columnheader">Unit price</span>
                    <span role="columnheader">Line total</span>
                    <span role="columnheader">Category</span>
                    <span role="columnheader" aria-label="Details" />
                  </div>
                </div>
                <div role="rowgroup">
                  {values.items.map((item, index) => {
                    const expanded = expandedItems.has(item.key);
                    const labelId = `item-${item.key}-label`;
                    const detailId = `item-${item.key}-details`;
                    return (
                      <div className="line-entry" key={item.key}>
                        <div
                          className="line-row"
                          role="row"
                          aria-labelledby={labelId}
                        >
                          <div
                            role="cell"
                            className="line-cell line-cell--select"
                            data-label="Select"
                          >
                            <label className="item-select">
                              <input
                                aria-label={`Item ${index + 1}`}
                                type="checkbox"
                                checked={selectedItems.has(item.key)}
                                onChange={(event) =>
                                  setSelectedItems((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked)
                                      next.add(item.key);
                                    else next.delete(item.key);
                                    return next;
                                  })
                                }
                              />
                            </label>
                          </div>
                          <div
                            role="cell"
                            className="line-cell line-cell--description"
                            data-label="Description"
                          >
                            <label
                              className="visually-hidden"
                              htmlFor={`item-${item.key}-description`}
                            >
                              Description
                            </label>
                            <input
                              id={`item-${item.key}-description`}
                              value={item.description}
                              title={item.description}
                              aria-describedby={
                                errors[`item-${index}-description`]
                                  ? `item-${item.key}-description-error`
                                  : undefined
                              }
                              onChange={(event) =>
                                updateItem(
                                  index,
                                  "description",
                                  event.target.value,
                                )
                              }
                            />
                            <span id={labelId} className="visually-hidden">
                              Item {index + 1}:{" "}
                              {item.description || "no description"}
                            </span>
                            {errors[`item-${index}-description`] && (
                              <small
                                id={`item-${item.key}-description-error`}
                                className="inline-error"
                              >
                                {errors[`item-${index}-description`]}
                              </small>
                            )}
                          </div>
                          {(
                            [
                              [
                                "Quantity",
                                "quantity",
                                item.quantity,
                                "decimal",
                              ],
                              [
                                "Unit price",
                                "unitPrice",
                                item.unitPrice,
                                "decimal",
                              ],
                              [
                                "Line total",
                                "lineTotal",
                                item.lineTotal,
                                "decimal",
                              ],
                            ] as const
                          ).map(([label, field, value, inputMode]) => (
                            <div
                              role="cell"
                              className="line-cell"
                              data-label={label}
                              key={field}
                            >
                              <label
                                className="visually-hidden"
                                htmlFor={`item-${item.key}-${field}`}
                              >
                                {label}
                              </label>
                              <input
                                id={`item-${item.key}-${field}`}
                                value={value}
                                inputMode={inputMode}
                                onChange={(event) =>
                                  updateItem(index, field, event.target.value)
                                }
                              />
                              {errors[`item-${index}-${field}`] && (
                                <small className="inline-error">
                                  {errors[`item-${index}-${field}`]}
                                </small>
                              )}
                            </div>
                          ))}
                          <div
                            role="cell"
                            className="line-cell line-cell--category"
                            data-label="Category"
                          >
                            <label
                              className="visually-hidden"
                              htmlFor={`item-${item.key}-category`}
                            >
                              Category
                            </label>
                            <select
                              id={`item-${item.key}-category`}
                              value={item.categoryId ?? ""}
                              onKeyDown={(event) => {
                                if (
                                  event.ctrlKey &&
                                  (event.key === "ArrowDown" ||
                                    event.key === "ArrowUp")
                                ) {
                                  event.preventDefault();
                                  const target =
                                    index +
                                    (event.key === "ArrowDown" ? 1 : -1);
                                  document
                                    .getElementById(
                                      `item-${values.items[target]?.key ?? ""}-category`,
                                    )
                                    ?.focus();
                                }
                              }}
                              onChange={(event) =>
                                updateItem(
                                  index,
                                  "categoryId",
                                  event.target.value || null,
                                )
                              }
                            >
                              <CategoryOptions
                                categories={categories}
                                value={item.categoryId ?? null}
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
                              aria-label={`${expanded ? "Collapse" : "Expand"} details for item ${index + 1}`}
                              aria-expanded={expanded}
                              aria-controls={detailId}
                              onClick={() => {
                                userToggledItems.current.add(item.key);
                                setExpandedItems((current) => {
                                  const next = new Set(current);
                                  if (next.has(item.key)) next.delete(item.key);
                                  else next.add(item.key);
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
                            className="line-detail"
                            id={detailId}
                            aria-labelledby={labelId}
                          >
                            <p className="line-description-full">
                              <strong>Full description:</strong>{" "}
                              {item.description || "No description"}
                            </p>
                            <div className="line-actions">
                              <button
                                aria-label={`Move item ${index + 1} up`}
                                disabled={index === 0}
                                onClick={() => move(index, -1)}
                              >
                                ↑
                              </button>
                              <button
                                aria-label={`Move item ${index + 1} down`}
                                disabled={index === values.items.length - 1}
                                onClick={() => move(index, 1)}
                              >
                                ↓
                              </button>
                              <button
                                className="danger-text"
                                aria-label={`Remove item ${index + 1}`}
                                onClick={() => remove(index)}
                              >
                                Remove
                              </button>
                            </div>
                            <small>
                              Use Ctrl + ↑/↓ to move between category controls.
                            </small>
                            <CategorySuggestionAdvice
                              description={item.description}
                              categoryId={item.categoryId ?? null}
                              brandId={values.merchantBrandId}
                              storeId={values.merchantStoreId}
                              categories={categories}
                              onAdopt={(categoryId) => {
                                updateItem(index, "categoryId", categoryId);
                                setStatus(
                                  "Suggestion adopted locally. Save the receipt to keep it.",
                                );
                              }}
                              onStatus={setStatus}
                              onActionable={() => {
                                if (!userToggledItems.current.has(item.key))
                                  setExpandedItems((current) => {
                                    if (current.has(item.key)) return current;
                                    return new Set(current).add(item.key);
                                  });
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </div>
        <div className="editor-sidebar">
          <aside className="panel totals" aria-label="Receipt totals">
            <p>
              Entered total{" "}
              <strong>
                {enteredTotal === null ? "—" : money.format(enteredTotal / 100)}
              </strong>
            </p>
            <p>
              Line-item sum{" "}
              <strong>{sum === null ? "—" : money.format(sum / 100)}</strong>
            </p>
            <div
              className={`reconcile ${discrepancy ? "reconcile--different" : ""}`}
              role="status"
            >
              {discrepancy
                ? `Difference: ${money.format(Math.abs(enteredTotal - sum) / 100)}`
                : "Totals match"}
            </div>
            <div className="save-status" aria-live="polite">
              {status || (dirty ? "Unsaved changes" : "All changes saved")}
            </div>
          </aside>
          <CategoryComposition
            title="Receipt composition"
            buckets={composition}
          />
        </div>
      </div>
      <div className="review-workspace">
        <AIReviewPanel
          receiptId={id}
          receiptUpdatedAt={receiptUpdatedAt}
          categories={categories}
          canonicalDirty={dirty}
          onApproved={load}
        />
        <DocumentPanel receiptId={id} />
      </div>
    </section>
  );
}

function EditorField({
  label,
  id,
  value,
  error,
  onChange,
  type = "text",
  inputMode,
}: {
  label: string;
  id: string;
  value: string;
  error?: string | undefined;
  onChange: (value: string) => void;
  type?: string;
  inputMode?: "decimal";
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        inputMode={inputMode}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && (
        <small id={`${id}-error`} className="field-error">
          {error}
        </small>
      )}
    </div>
  );
}
