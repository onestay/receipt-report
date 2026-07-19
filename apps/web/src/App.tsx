import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  apiErrorSchema,
  receiptDetailSchema,
  receiptListSchema,
  type ReceiptSummary,
} from "@receipt-report/contracts";

type Route = { page: "list" | "new" | "detail"; id?: string };
const money = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

function route(): Route {
  if (location.pathname === "/receipts/new") return { page: "new" };
  const match = location.pathname.match(/^\/receipts\/([^/]+)$/);
  return match?.[1] ? { page: "detail", id: match[1] } : { page: "list" };
}

export function navigate(path: string) {
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
    const update = () => setCurrent(route());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
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
          <DetailPlaceholder id={current.id} />
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
                  <strong>{receipt.merchant}</strong>
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

function CreateReceipt() {
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const merchant = String(data.get("merchant") ?? "").trim();
    const purchaseDate = String(data.get("purchaseDate") ?? "");
    const total = parseMoney(String(data.get("total") ?? ""));
    const next: Record<string, string> = {};
    if (!merchant) next.merchant = "Enter a merchant.";
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
        merchant,
        purchaseDate,
        purchaseTime: String(data.get("purchaseTime") || "") || null,
        totalCents: total,
        notes: String(data.get("notes") || "") || null,
      };
      const response = await fetch("/api/v1/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(await response.json());
        throw new Error(
          parsed.success && parsed.data.error.code === "validation_error"
            ? "Please check the entered values."
            : "The receipt may not have been saved. Check the ledger before retrying.",
        );
      }
      const created = receiptDetailSchema.parse(await response.json());
      navigate(`/receipts/${created.id}`);
    } catch (error) {
      setServerError(
        error instanceof Error
          ? error.message
          : "The receipt could not be saved.",
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
          {serverError}
        </div>
      )}
      <form
        className="panel receipt-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <div className="field field--wide">
          <label htmlFor="merchant">Merchant</label>
          <input
            id="merchant"
            name="merchant"
            autoFocus
            aria-invalid={!!errors.merchant}
            aria-describedby={errors.merchant ? "merchant-error" : undefined}
          />
          {errors.merchant && (
            <small id="merchant-error" className="field-error">
              {errors.merchant}
            </small>
          )}
        </div>
        <div className="field">
          <label htmlFor="purchaseDate">Purchase date</label>
          <input
            id="purchaseDate"
            name="purchaseDate"
            type="date"
            aria-invalid={!!errors.purchaseDate}
          />
          {errors.purchaseDate && (
            <small className="field-error">{errors.purchaseDate}</small>
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
            />
          </div>
          {errors.total && (
            <small className="field-error">{errors.total}</small>
          )}
        </div>
        <div className="field field--wide">
          <label htmlFor="notes">
            Notes <span>optional</span>
          </label>
          <textarea id="notes" name="notes" rows={4} />
        </div>
        <div className="form-actions">
          <Link href="/receipts" className="button button--quiet">
            Cancel
          </Link>
          <button className="button" disabled={submitting}>
            {submitting ? "Saving…" : "Save receipt"}
          </button>
        </div>
      </form>
    </section>
  );
}

function DetailPlaceholder({ id }: { id: string }) {
  return (
    <section className="form-page">
      <div className="breadcrumb">
        <Link href="/receipts">← Ledger</Link>
      </div>
      <p className="eyebrow">Receipt saved</p>
      <h1>Ready for detail.</h1>
      <div className="panel state">
        <p>
          Your receipt <code>{id}</code> is safely in the ledger. Detailed
          editing arrives next.
        </p>
        <Link href="/receipts" className="button">
          Back to ledger
        </Link>
      </div>
    </section>
  );
}
