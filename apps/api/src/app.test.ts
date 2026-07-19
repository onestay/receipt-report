import { execFileSync } from "node:child_process";
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
      .expect(404, {
        error: { code: "not_found", message: "Route not found" },
      });
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
      .expect(404, {
        error: { code: "not_found", message: "Route not found" },
      });
  });

  it("exercises a real isolated API/database boundary", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-api-${process.pid}-`),
    );
    database = await createDatabase(`file:${join(directory, "api.db")}`);
    await expect(checkDatabase(database)).resolves.toBe(true);
    await request(createApp()).get("/api/v1/health").expect(200);
  });

  it("supports receipt CRUD, atomic replacement, and sanitized failures", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-crud-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "crud.db")}`;
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    database = await createDatabase(databaseUrl);
    const app = createApp({ database });
    const created = await request(app)
      .post("/api/v1/receipts")
      .send({
        merchant: " Test Markt ",
        purchaseDate: "2026-07-19",
        purchaseTime: "18:42",
        totalCents: 450,
        notes: " synthetic ",
        lineItems: [
          { description: "A", lineTotalCents: 100 },
          {
            description: "B",
            quantityMilli: 485,
            unitPriceCents: 200,
            lineTotalCents: 350,
          },
        ],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      merchant: "Test Markt",
      currency: "EUR",
      notes: "synthetic",
    });
    expect(
      created.body.lineItems.map(
        (item: { description: string }) => item.description,
      ),
    ).toEqual(["A", "B"]);
    const id: string = created.body.id;
    await request(app).get(`/api/v1/receipts/${id}`).expect(200);
    await request(app).get("/api/v1/receipts?limit=1").expect(200);
    const updated = await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({
        merchant: "Changed",
        lineItems: [{ description: "B", lineTotalCents: 350 }],
      })
      .expect(200);
    expect(updated.body.lineItems[0]).toMatchObject({
      description: "B",
      position: 0,
    });
    const fieldsUpdated = await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({
        purchaseDate: "2026-07-18",
        purchaseTime: null,
        currency: "EUR",
        notes: null,
        totalCents: 451,
      })
      .expect(200);
    expect(fieldsUpdated.body).toMatchObject({
      purchaseDate: "2026-07-18",
      purchaseTime: null,
      notes: null,
      totalCents: 451,
    });
    await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({ totalCents: -1 })
      .expect(400);
    await request(app)
      .get(`/api/v1/receipts/${id}`)
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          totalCents: 451,
          merchant: "Changed",
        }),
      );
    await request(app).delete(`/api/v1/receipts/${id}`).expect(204);
    await request(app).delete(`/api/v1/receipts/${id}`).expect(404);
    await request(app).get(`/api/v1/receipts/${id}`).expect(404);
    await request(app).get("/api/v1/receipts/not-an-id").expect(400);
    await request(app).get("/api/v1/receipts?limit=101").expect(400);
    await request(app)
      .get("/api/v1/receipts?cursor=garbage")
      .expect(400, {
        error: { code: "invalid_cursor", message: "Invalid pagination cursor" },
      });
    for (const cursor of [
      Buffer.from("null").toString("base64url"),
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({ purchaseDate: 3, id: "x" })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ purchaseDate: "bad", id: "x" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ purchaseDate: "2026-01-01", id: 3 }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ purchaseDate: "2026-01-01", id: "" }),
      ).toString("base64url"),
    ]) {
      await request(app).get(`/api/v1/receipts?cursor=${cursor}`).expect(400);
    }
  });

  it("paginates equal-date receipts without duplicates", async () => {
    directory = await mkdtemp(
      join(tmpdir(), `receipt-report-pages-${process.pid}-`),
    );
    const databaseUrl = `file:${join(directory, "pages.db")}`;
    execFileSync(
      "pnpm",
      ["--filter", "@receipt-report/database", "db:migrate:deploy"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    database = await createDatabase(databaseUrl);
    const app = createApp({ database });
    for (const merchant of ["A", "B", "C"])
      await request(app)
        .post("/api/v1/receipts")
        .send({ merchant, purchaseDate: "2026-07-19", totalCents: 1 })
        .expect(201);
    const first = await request(app)
      .get("/api/v1/receipts?limit=2")
      .expect(200);
    const second = await request(app)
      .get(
        `/api/v1/receipts?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )
      .expect(200);
    const ids = [...first.body.receipts, ...second.body.receipts].map(
      (receipt: { id: string }) => receipt.id,
    );
    expect(new Set(ids).size).toBe(3);
    expect(second.body.nextCursor).toBeNull();
  });
});
