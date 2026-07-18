import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { healthResponseSchema } from "@receipt-report/contracts";
import {
  checkDatabase,
  createDatabase,
  type Database,
} from "@receipt-report/database";
import { createApp } from "./app.js";

let database: Database | undefined;
let directory: string | undefined;

afterEach(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  database = undefined;
  directory = undefined;
});

describe("API", () => {
  it("returns the shared liveness contract without a database", async () => {
    const response = await request(createApp())
      .get("/api/v1/health")
      .expect(200);
    expect(healthResponseSchema.parse(response.body)).toEqual(response.body);
  });

  it("returns 404 for an unversioned route", async () => {
    await request(createApp())
      .get("/health")
      .expect(404, { error: "not_found" });
  });

  it("serves the built web app and its client-side routes", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-web-${process.pid}-`),
    );
    await writeFile(join(directory, "index.html"), "<h1>built web</h1>");
    const app = createApp({ webDistDirectory: directory });
    await request(app)
      .get("/")
      .expect(200, /built web/);
    await request(app)
      .get("/receipts/example")
      .expect(200, /built web/);
  });

  it("does not mount a missing web build", async () => {
    await request(createApp({ webDistDirectory: "/definitely/missing" }))
      .get("/")
      .expect(404, { error: "not_found" });
  });

  it("exercises a real isolated API/database boundary", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-api-${process.pid}-`),
    );
    database = await createDatabase(`file:${join(directory, "api.db")}`);
    await expect(checkDatabase(database)).resolves.toBe(true);
    await request(createApp()).get("/api/v1/health").expect(200);
  });
});
