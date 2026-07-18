import { useEffect, useState } from "react";
import { healthResponseSchema } from "@receipt-report/contracts";

type ApiState = "checking" | "ready" | "unavailable";

export function App() {
  const [apiState, setApiState] = useState<ApiState>("checking");

  useEffect(() => {
    const controller = new AbortController();
    async function checkHealth() {
      try {
        const response = await fetch("/api/v1/health", {
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Health check failed with ${response.status}`);
        healthResponseSchema.parse(await response.json());
        setApiState("ready");
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setApiState("unavailable");
      }
    }
    void checkHealth();
    return () => controller.abort();
  }, []);

  return (
    <main>
      <section className="shell" aria-labelledby="page-title">
        <p className="eyebrow">Private receipt intelligence</p>
        <h1 id="page-title">Receipt Report</h1>
        <p className="lede">
          A calm home for receipts, review, and useful spending reports.
        </p>
        <div
          className={`status status--${apiState}`}
          role="status"
          aria-live="polite"
        >
          <span aria-hidden="true" />
          {apiState === "checking" && "Checking local API…"}
          {apiState === "ready" && "Local API connected"}
          {apiState === "unavailable" && "Local API unavailable"}
        </div>
      </section>
    </main>
  );
}
