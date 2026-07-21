import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  apiErrorSchema,
  merchantBrandListSchema,
  merchantBrandSchema,
  merchantStoreListSchema,
  merchantStoreSchema,
  normalizeMerchantAddressKey,
  normalizeMerchantName,
  receiptDetailSchema,
  receiptListSchema,
  type MerchantBrand,
  type MerchantStore,
  type ReceiptDetail,
  type ReceiptSummary,
} from "@receipt-report/contracts";
import {
  DocumentFileField,
  DocumentPanel,
  DocumentUploadError,
  failureMessage,
  uploadReceiptDocument,
} from "./DocumentPanel.js";

type Route = { page: "list" | "new" | "detail"; id?: string };
const money = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});
let navigationGuard: (() => boolean) | undefined;
let ignoreNextPop = false;

function route(): Route {
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
    document.title = `${current.page === "list" ? "Ledger" : current.page === "new" ? "New receipt" : "Receipt detail"} · Receipt Report`;
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
          <Link href="/receipts/new" className="button button--small">
            New receipt
          </Link>
        </nav>
      </header>
      <main className="page">
        {current.page === "list" && <ReceiptList />}
        {current.page === "new" && <CreateReceipt />}
        {current.page === "detail" && current.id && (
          <ReceiptEditor id={current.id} />
        )}
      </main>
      <footer>Quietly kept on your own server.</footer>
    </div>
  );
}

export function formatDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
}

function ReceiptList() {
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<
    "loading" | "ready" | "error" | "unavailable"
  >("loading");
  const load = useCallback(async (next?: string) => {
    setState("loading");
    try {
      const response = await fetch(
        `/api/v1/receipts${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
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
          <h2 id="ledger-title">Recent receipts</h2>
          <span>{receipts.length} entries</span>
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

export function parseQuantity(value: string): number | null {
  const match = value.trim().match(/^(\d+)(?:[,.](\d{1,3}))?$/);
  if (!match) return null;
  const milli =
    Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

function centsInput(value: number | null): string {
  return value === null
    ? ""
    : `${Math.floor(value / 100)},${String(value % 100).padStart(2, "0")}`;
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [createdReceiptId, setCreatedReceiptId] = useState<string>();
  const [duplicateReceiptId, setDuplicateReceiptId] = useState<string>();
  const uploadAbort = useRef<AbortController | undefined>(undefined);
  const [merchantIdentity, setMerchantIdentity] =
    useState<MerchantIdentityValue>({
      merchantBrandId: null,
      merchantStoreId: null,
    });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const merchantRaw = String(data.get("merchantRaw") ?? "").trim();
    const purchaseDate = String(data.get("purchaseDate") ?? "");
    const total = parseMoney(String(data.get("total") ?? ""));
    const next: Record<string, string> = {};
    if (!merchantRaw) next.merchantRaw = "Enter a merchant.";
    if (!purchaseDate) next.purchaseDate = "Choose a purchase date.";
    if (total === null)
      next.total = "Enter euros with up to two decimal places.";
    setErrors(next);
    if (Object.keys(next).length) {
      document.querySelector<HTMLElement>(".validation-summary")?.focus();
      return;
    }
    setSubmitting(true);
    setServerError("");
    try {
      const body = {
        merchantRaw,
        ...merchantIdentity,
        purchaseDate,
        purchaseTime: String(data.get("purchaseTime") || "") || null,
        totalCents: total,
        notes: String(data.get("notes") || "") || null,
      };
      let receiptId = createdReceiptId;
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
      <p className="eyebrow">Manual entry</p>
      <h1>New receipt</h1>
      <p className="intro">
        Capture the essentials now. You can add line items on the next screen.
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
          <label htmlFor="merchantRaw">Merchant</label>
          <input
            id="merchantRaw"
            name="merchantRaw"
            autoFocus
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
        <div className="field">
          <label htmlFor="purchaseDate">Purchase date</label>
          <input
            id="purchaseDate"
            name="purchaseDate"
            type="date"
            aria-invalid={!!errors.purchaseDate}
            aria-describedby={
              errors.purchaseDate ? "purchaseDate-error" : undefined
            }
          />
          {errors.purchaseDate && (
            <small id="purchaseDate-error" className="field-error">
              {errors.purchaseDate}
            </small>
          )}
        </div>
        <div className="field">
          <label htmlFor="purchaseTime">
            Time <span>optional</span>
          </label>
          <input id="purchaseTime" name="purchaseTime" type="time" />
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
          <textarea id="notes" name="notes" rows={4} />
        </div>
        <div className="field field--wide">
          <span className="field-label">
            Receipt document <span>optional</span>
          </span>
          <DocumentFileField
            id="new-receipt-document"
            file={documentFile}
            disabled={submitting}
            onFile={setDocumentFile}
            onError={setServerError}
          />
        </div>
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
                : "Save receipt"}
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
    purchaseDate: receipt.purchaseDate,
    purchaseTime: receipt.purchaseTime ?? "",
    total: centsInput(receipt.totalCents),
    notes: receipt.notes ?? "",
    items: receipt.lineItems.map((item) => ({
      key: item.id,
      description: item.description,
      quantity: quantityInput(item.quantityMilli ?? null),
      unitPrice: centsInput(item.unitPriceCents ?? null),
      lineTotal: centsInput(item.lineTotalCents),
    })),
  };
}

export function lineTotalSum<T extends Pick<EditorValues, "items">>(
  values: T,
): number | null {
  let total = 0;
  for (const item of values.items) {
    const cents = parseMoney(item.lineTotal);
    if (cents === null) return null;
    total += cents;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
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
    notes: "",
    items: [],
  };
  const [values, setValues] = useState<EditorValues>(empty);
  const [saved, setSaved] = useState<EditorValues>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
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
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
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
    value: string,
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
    const items = values.items.filter((_item, at) => at !== index);
    update("items", items);
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
      { key, description: "", quantity: "", unitPrice: "", lineTotal: "" },
    ]);
    requestAnimationFrame(() =>
      document.getElementById(`item-${key}-description`)?.focus(),
    );
  };
  async function save() {
    const nextErrors: Record<string, string> = {};
    const total = parseMoney(values.total);
    if (!values.merchantRaw.trim())
      nextErrors.merchantRaw = "Enter a merchant.";
    if (!total && total !== 0)
      nextErrors.total = "Enter a valid non-negative EUR amount.";
    const lineItems = values.items.map((item, index) => {
      const lineTotal = parseMoney(item.lineTotal);
      const quantity = item.quantity ? parseQuantity(item.quantity) : null;
      const unitPrice = item.unitPrice ? parseMoney(item.unitPrice) : null;
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
        description: item.description.trim(),
        quantityMilli: quantity,
        unitPriceCents: unitPrice,
        lineTotalCents: lineTotal ?? 0,
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
          purchaseDate: values.purchaseDate,
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
  const sum = lineTotalSum(values);
  const enteredTotal = parseMoney(values.total);
  const discrepancy =
    sum !== null && enteredTotal !== null && sum !== enteredTotal;
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
            <EditorField
              label="Purchase date"
              id="editor-date"
              type="date"
              value={values.purchaseDate}
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
            {values.items.length === 0 && (
              <div className="panel state">
                <p>No line items yet.</p>
              </div>
            )}
            {values.items.map((item, index) => (
              <article className="panel item" key={item.key}>
                <div className="item-title">
                  <strong>Item {index + 1}</strong>
                  <div>
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
                </div>
                <div className="item-fields">
                  <EditorField
                    label="Description"
                    id={`item-${item.key}-description`}
                    value={item.description}
                    error={errors[`item-${index}-description`]}
                    onChange={(value) =>
                      updateItem(index, "description", value)
                    }
                  />
                  <EditorField
                    label="Quantity"
                    id={`item-${item.key}-quantity`}
                    value={item.quantity}
                    error={errors[`item-${index}-quantity`]}
                    inputMode="decimal"
                    onChange={(value) => updateItem(index, "quantity", value)}
                  />
                  <EditorField
                    label="Unit price"
                    id={`item-${item.key}-unitPrice`}
                    value={item.unitPrice}
                    error={errors[`item-${index}-unitPrice`]}
                    inputMode="decimal"
                    onChange={(value) => updateItem(index, "unitPrice", value)}
                  />
                  <EditorField
                    label="Line total"
                    id={`item-${item.key}-lineTotal`}
                    value={item.lineTotal}
                    error={errors[`item-${index}-lineTotal`]}
                    inputMode="decimal"
                    onChange={(value) => updateItem(index, "lineTotal", value)}
                  />
                </div>
              </article>
            ))}
          </section>
        </div>
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
      </div>
      <DocumentPanel receiptId={id} />
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
