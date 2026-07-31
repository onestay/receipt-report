import { useCallback, useEffect, useState } from "react";
import {
  apiErrorSchema,
  categorySuggestionRuleListSchema,
  type Category,
  type CategorySuggestionRule,
} from "@receipt-report/contracts";
import {
  CategoryOptions,
  categoryLabel,
  loadCategories,
} from "./Categories.js";

function scopeLabel(rule: CategorySuggestionRule): string {
  if (rule.scopeKind === "global") return "Global";
  if (rule.scopeKind === "brand") return `Brand · ${rule.brandId}`;
  return `Store · ${rule.storeId}`;
}

export function CategorySuggestionRuleManager() {
  const [rules, setRules] = useState<CategorySuggestionRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [validity, setValidity] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");

  const reload = useCallback(async () => {
    setState("loading");
    try {
      const parameters = new URLSearchParams();
      if (query.trim()) parameters.set("query", query.trim());
      if (validity) parameters.set("validity", validity);
      const response = await fetch(
        `/api/v1/category-suggestion-rules?${parameters}`,
      );
      if (!response.ok) throw new Error("rules");
      const [parsed, loadedCategories] = await Promise.all([
        response
          .json()
          .then((body) => categorySuggestionRuleListSchema.parse(body)),
        loadCategories(),
      ]);
      setRules(parsed.rules);
      setCategories(loadedCategories);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [query, validity]);
  useEffect(() => void reload(), [reload]);

  async function update(rule: CategorySuggestionRule, categoryId: string) {
    setMessage("");
    const response = await fetch(
      `/api/v1/category-suggestion-rules/${rule.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: rule.description,
          categoryId,
          scopeKind: rule.scopeKind,
          brandId: rule.brandId,
          storeId: rule.storeId,
        }),
      },
    ).catch(() => null);
    if (!response?.ok) {
      setMessage("The rule could not be repaired. Nothing was changed.");
      return;
    }
    setMessage("Rule updated.");
    await reload();
  }

  async function remove(rule: CategorySuggestionRule) {
    if (!window.confirm(`Delete the rule for “${rule.description}”?`)) return;
    const response = await fetch(
      `/api/v1/category-suggestion-rules/${rule.id}`,
      { method: "DELETE" },
    ).catch(() => null);
    if (!response?.ok) {
      setMessage("The rule could not be deleted. Nothing was changed.");
      return;
    }
    setMessage("Rule deleted.");
    await reload();
  }

  return (
    <section className="category-page">
      <p className="eyebrow">Transparent exact matching</p>
      <h1>Category rules</h1>
      <p className="intro">
        Rules suggest one category for an exact normalized line description.
        They never rewrite receipt text or change a line automatically.
      </p>
      <div className="panel category-create">
        <div className="field">
          <label htmlFor="rule-search">Search descriptions</label>
          <input
            id="rule-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="rule-validity">Validity</label>
          <select
            id="rule-validity"
            value={validity}
            onChange={(event) => setValidity(event.target.value)}
          >
            <option value="">All rules</option>
            <option value="valid">Valid</option>
            <option value="invalid">Needs repair</option>
          </select>
        </div>
      </div>
      {message && (
        <div className="banner" role="status">
          {message}
        </div>
      )}
      {state === "loading" && <div className="panel state">Loading rules…</div>}
      {state === "error" && (
        <div className="panel state" role="alert">
          Rules could not be loaded.{" "}
          <button onClick={() => void reload()}>Try again</button>
        </div>
      )}
      {state === "ready" && rules.length === 0 && (
        <div className="panel state">No matching rules.</div>
      )}
      <div className="category-list">
        {rules.map((rule) => (
          <article className="panel category-row" key={rule.id}>
            <div>
              <strong>{rule.description}</strong>
              <small>
                {scopeLabel(rule)} · {categoryLabel(rule.category, categories)}
              </small>
              {!rule.isValid && (
                <p className="inline-error" role="alert">
                  Needs repair: {rule.invalidReason}
                </p>
              )}
            </div>
            <div className="category-row__actions">
              <label className="field">
                <span>{rule.isValid ? "Target" : "Repair target"}</span>
                <select
                  value={rule.categoryId}
                  onChange={(event) => void update(rule, event.target.value)}
                >
                  <CategoryOptions
                    categories={categories}
                    value={rule.categoryId}
                  />
                </select>
              </label>
              <button
                className="button button--quiet danger"
                onClick={() => void remove(rule)}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="intro">
        Normalized descriptions can contain sensitive purchase text. They stay
        local unless a later, explicitly configured AI request sends them.
      </p>
    </section>
  );
}

export async function rememberCategoryRule(input: {
  description: string;
  categoryId: string;
  scopeKind: "global" | "brand" | "store";
  brandId: string | null;
  storeId: string | null;
}): Promise<"created" | "replaced" | "cancelled"> {
  const create = () =>
    fetch("/api/v1/category-suggestion-rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  const response = await create();
  if (response.ok) return "created";
  const body: unknown = await response.json().catch(() => undefined);
  const error = apiErrorSchema.safeParse(body);
  if (!error.success || error.data.error.code !== "conflict") {
    throw new Error("remember");
  }
  const parameters = new URLSearchParams({
    query: input.description,
    scopeKind: input.scopeKind,
    limit: "100",
  });
  if (input.brandId) parameters.set("brandId", input.brandId);
  if (input.storeId) parameters.set("storeId", input.storeId);
  const existingResponse = await fetch(
    `/api/v1/category-suggestion-rules?${parameters}`,
  );
  if (!existingResponse.ok) throw new Error("existing");
  const existing = categorySuggestionRuleListSchema
    .parse(await existingResponse.json())
    .rules.find(
      (rule) =>
        rule.normalizedDescription ===
        input.description
          .normalize("NFC")
          .trim()
          .replace(/\s+/gu, " ")
          .toLocaleLowerCase("de-DE"),
    );
  if (!existing) throw new Error("existing");
  if (
    !window.confirm(
      `A ${scopeLabel(existing).toLowerCase()} rule already maps “${existing.description}” to ${existing.category.name}. Replace its target?`,
    )
  ) {
    return "cancelled";
  }
  const replaced = await fetch(
    `/api/v1/category-suggestion-rules/${existing.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!replaced.ok) throw new Error("replace");
  return "replaced";
}
