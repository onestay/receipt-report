import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

const port = 4173;

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command:
      "pnpm --filter @receipt-report/database db:migrate:deploy && pnpm --filter @receipt-report/api start",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_URL: `file:${resolve(".runtime/e2e.db")}`,
      STORAGE_PATH: resolve(".runtime/e2e-storage"),
      WEB_DIST_DIR: "../web/dist",
    },
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
