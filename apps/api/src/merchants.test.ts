import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@receipt-report/database";
import type { Express } from "express";
import { createApp } from "./app.js";

let database: Database | undefined;
let directory: string | undefined;
let app: Express;

beforeEach(async () => {
  directory = await mkdtemp(
    join(tmpdir(), `receipt-report-merchants-${process.pid}-`),
  );
  const databaseUrl = `file:${join(directory, "merchants.db")}`;
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
  app = createApp({ database });
});

afterEach(async () => {
  await database?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  database = undefined;
  directory = undefined;
});

async function createBrand(name: string): Promise<string> {
  const response = await request(app)
    .post("/api/v1/merchant-brands")
    .send({ name })
    .expect(201);
  return response.body.id as string;
}

async function createStore(
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app).post("/api/v1/merchant-stores").send(body);
}

const receipt = { purchaseDate: "2026-07-19", totalCents: 999 };

describe("merchant brands", () => {
  it("creates, reads, updates, and preserves display spelling", async () => {
    const created = await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "  EDEKA  " })
      .expect(201);
    expect(created.body).toMatchObject({
      name: "EDEKA",
      normalizedName: "edeka",
    });
    const id: string = created.body.id;
    await request(app)
      .get(`/api/v1/merchant-brands/${id}`)
      .expect(200)
      .expect((response) => expect(response.body.name).toBe("EDEKA"));
    await request(app)
      .patch(`/api/v1/merchant-brands/${id}`)
      .send({ name: "Edeka Zentrale" })
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          name: "Edeka Zentrale",
          normalizedName: "edeka zentrale",
        }),
      );
    await request(app).delete(`/api/v1/merchant-brands/${id}`).expect(204);
    await request(app).get(`/api/v1/merchant-brands/${id}`).expect(404);
  });

  it("returns conflict for a normalized-name collision", async () => {
    await createBrand("EDEKA");
    await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "  edeka  " })
      .expect(409, {
        error: {
          code: "conflict",
          message: "Merchant brand name already exists",
        },
      });
  });

  it("returns conflict when renaming onto an existing brand", async () => {
    await createBrand("EDEKA");
    const reweId = await createBrand("REWE");
    await request(app)
      .patch(`/api/v1/merchant-brands/${reweId}`)
      .send({ name: "edeka" })
      .expect(409);
  });

  it("keeps ß and diacritics distinct from their folded spellings", async () => {
    await createBrand("Straßen Markt");
    await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "Strassen Markt" })
      .expect(201);
    await createBrand("Müller");
    await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "Muller" })
      .expect(201);
  });

  it("searches and paginates by normalized name then id", async () => {
    for (const name of ["Netto", "EDEKA", "REWE", "Aldi"])
      await createBrand(name);
    const first = await request(app)
      .get("/api/v1/merchant-brands?limit=2")
      .expect(200);
    expect(
      first.body.brands.map((brand: { name: string }) => brand.name),
    ).toEqual(["Aldi", "EDEKA"]);
    const second = await request(app)
      .get(
        `/api/v1/merchant-brands?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      )
      .expect(200);
    expect(
      second.body.brands.map((brand: { name: string }) => brand.name),
    ).toEqual(["Netto", "REWE"]);
    expect(second.body.nextCursor).toBeNull();
    const searched = await request(app)
      .get("/api/v1/merchant-brands?query=%20edek%20")
      .expect(200);
    expect(searched.body.brands).toHaveLength(1);
    expect(searched.body.brands[0].name).toBe("EDEKA");
  });

  it("rejects a malformed cursor", async () => {
    await request(app)
      .get("/api/v1/merchant-brands?cursor=garbage")
      .expect(400, {
        error: { code: "invalid_cursor", message: "Invalid pagination cursor" },
      });
  });

  it("rejects invalid input and unknown ids", async () => {
    await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "  " })
      .expect(400);
    await request(app)
      .post("/api/v1/merchant-brands")
      .send({ name: "EDEKA", unexpected: true })
      .expect(400);
    await request(app).get("/api/v1/merchant-brands/not-an-id").expect(400);
    await request(app)
      .get("/api/v1/merchant-brands/clx0000000000000000000000")
      .expect(404);
  });
});

describe("merchant stores", () => {
  it("creates a store with an optional address under its brand", async () => {
    const brandId = await createBrand("EDEKA");
    const created = await createStore({
      brandId,
      name: "  EDEKA Müller  ",
      street: "Hauptstraße 1",
      postalCode: "10115",
      city: "Berlin",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      brandId,
      name: "EDEKA Müller",
      normalizedName: "edeka müller",
      street: "Hauptstraße 1",
      city: "Berlin",
    });
    const addressless = await createStore({ brandId, name: "EDEKA Bahnhof" });
    expect(addressless.status).toBe(201);
    expect(addressless.body).toMatchObject({
      street: null,
      postalCode: null,
      city: null,
    });
  });

  it("allows same-name stores at different known addresses", async () => {
    const brandId = await createBrand("EDEKA");
    await createStore({
      brandId,
      name: "EDEKA Müller",
      street: "Hauptstraße 1",
      city: "Berlin",
    }).then((response) => expect(response.status).toBe(201));
    await createStore({
      brandId,
      name: "EDEKA Müller",
      street: "Bahnhofstraße 9",
      city: "Berlin",
    }).then((response) => expect(response.status).toBe(201));
  });

  it("returns conflict for two address-less same-name stores", async () => {
    const brandId = await createBrand("EDEKA");
    await createStore({ brandId, name: "EDEKA Müller" }).then((response) =>
      expect(response.status).toBe(201),
    );
    const duplicate = await createStore({ brandId, name: "  edeka müller " });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("conflict");
  });

  it("scopes uniqueness to a single brand", async () => {
    const edeka = await createBrand("EDEKA");
    const rewe = await createBrand("REWE");
    await createStore({ brandId: edeka, name: "Müller" }).then((response) =>
      expect(response.status).toBe(201),
    );
    await createStore({ brandId: rewe, name: "Müller" }).then((response) =>
      expect(response.status).toBe(201),
    );
  });

  it("updates a store and reports collisions", async () => {
    const brandId = await createBrand("EDEKA");
    const first = await createStore({
      brandId,
      name: "EDEKA Nord",
      city: "Hamburg",
    });
    const second = await createStore({ brandId, name: "EDEKA Süd" });
    await request(app)
      .patch(`/api/v1/merchant-stores/${second.body.id}`)
      .send({ city: "Hamburg" })
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          name: "EDEKA Süd",
          city: "Hamburg",
        }),
      );
    // Same brand, same name, same address as the first store.
    await request(app)
      .patch(`/api/v1/merchant-stores/${second.body.id}`)
      .send({ name: "EDEKA Nord" })
      .expect(409);
    await request(app)
      .get(`/api/v1/merchant-stores/${first.body.id}`)
      .expect(200);
  });

  it("keeps a saved address when only the name is patched", async () => {
    const brandId = await createBrand("EDEKA");
    const created = await createStore({
      brandId,
      name: "EDEKA Nord",
      street: "Hauptstraße 1",
      postalCode: "10115",
      city: "Berlin",
    });
    const renamed = await request(app)
      .patch(`/api/v1/merchant-stores/${created.body.id}`)
      .send({ name: "EDEKA Nord renamed" })
      .expect(200);
    expect(renamed.body).toMatchObject({
      name: "EDEKA Nord renamed",
      street: "Hauptstraße 1",
      postalCode: "10115",
      city: "Berlin",
    });
    expect(renamed.body.normalizedAddressKey).toBe(
      created.body.normalizedAddressKey,
    );
    // The stored row, not just the response, kept the address.
    await request(app)
      .get(`/api/v1/merchant-stores/${created.body.id}`)
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          street: "Hauptstraße 1",
          city: "Berlin",
        }),
      );
  });

  it("patches address fields independently and clears them explicitly", async () => {
    const brandId = await createBrand("EDEKA");
    const created = await createStore({
      brandId,
      name: "EDEKA Nord",
      street: "Hauptstraße 1",
      postalCode: "10115",
      city: "Berlin",
    });
    await request(app)
      .patch(`/api/v1/merchant-stores/${created.body.id}`)
      .send({ city: "Hamburg" })
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          street: "Hauptstraße 1",
          postalCode: "10115",
          city: "Hamburg",
        }),
      );
    await request(app)
      .patch(`/api/v1/merchant-stores/${created.body.id}`)
      .send({ street: null, postalCode: "", city: null })
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          name: "EDEKA Nord",
          street: null,
          postalCode: null,
          city: null,
        }),
      );
  });

  it("rejects an empty store patch", async () => {
    const brandId = await createBrand("EDEKA");
    const created = await createStore({ brandId, name: "EDEKA Nord" });
    await request(app)
      .patch(`/api/v1/merchant-stores/${created.body.id}`)
      .send({})
      .expect(400);
  });

  it("filters, searches, and paginates stores", async () => {
    const edeka = await createBrand("EDEKA");
    const rewe = await createBrand("REWE");
    for (const name of ["Nord", "Süd", "Ost"])
      await createStore({ brandId: edeka, name });
    await createStore({ brandId: rewe, name: "West" });
    const scoped = await request(app)
      .get(`/api/v1/merchant-stores?brandId=${edeka}&limit=2`)
      .expect(200);
    expect(
      scoped.body.stores.map((store: { name: string }) => store.name),
    ).toEqual(["Nord", "Ost"]);
    const next = await request(app)
      .get(
        `/api/v1/merchant-stores?brandId=${edeka}&limit=2&cursor=${encodeURIComponent(scoped.body.nextCursor)}`,
      )
      .expect(200);
    expect(
      next.body.stores.map((store: { name: string }) => store.name),
    ).toEqual(["Süd"]);
    expect(next.body.nextCursor).toBeNull();
    const searched = await request(app)
      .get("/api/v1/merchant-stores?query=wes")
      .expect(200);
    expect(searched.body.stores).toHaveLength(1);
    expect(searched.body.stores[0].brandId).toBe(rewe);
  });

  it("rejects a store for an unknown brand", async () => {
    const response = await createStore({
      brandId: "clx0000000000000000000000",
      name: "EDEKA Müller",
    });
    expect(response.status).toBe(404);
  });
});

describe("restrictive merchant deletion", () => {
  it("blocks deleting a brand that still has stores", async () => {
    const brandId = await createBrand("EDEKA");
    const store = await createStore({ brandId, name: "EDEKA Nord" });
    await request(app)
      .delete(`/api/v1/merchant-brands/${brandId}`)
      .expect(409, {
        error: {
          code: "conflict",
          message: "Merchant brand still has stores or linked receipts",
        },
      });
    await request(app)
      .delete(`/api/v1/merchant-stores/${store.body.id}`)
      .expect(204);
    await request(app).delete(`/api/v1/merchant-brands/${brandId}`).expect(204);
  });

  it("blocks deleting a brand or store linked from a receipt", async () => {
    const brandId = await createBrand("EDEKA");
    const store = await createStore({ brandId, name: "EDEKA Nord" });
    const created = await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "EDEKA M. Müller e.K.",
        merchantBrandId: brandId,
        merchantStoreId: store.body.id,
      })
      .expect(201);
    await request(app).delete(`/api/v1/merchant-brands/${brandId}`).expect(409);
    await request(app)
      .delete(`/api/v1/merchant-stores/${store.body.id}`)
      .expect(409, {
        error: {
          code: "conflict",
          message: "Merchant store still has linked receipts",
        },
      });
    // The receipt keeps its canonical identity; nothing was unlinked.
    await request(app)
      .get(`/api/v1/receipts/${created.body.id}`)
      .expect(200)
      .expect((response) =>
        expect(response.body.merchantStore.id).toBe(store.body.id),
      );
  });

  it("returns not_found for deleting an unknown brand or store", async () => {
    await request(app)
      .delete("/api/v1/merchant-brands/clx0000000000000000000000")
      .expect(404);
    await request(app)
      .delete("/api/v1/merchant-stores/clx0000000000000000000000")
      .expect(404);
  });
});

describe("receipt merchant identity", () => {
  it("supports raw-only, brand-only, and store-linked receipts", async () => {
    const brandId = await createBrand("EDEKA");
    const store = await createStore({
      brandId,
      name: "EDEKA Müller",
      city: "Berlin",
    });
    const rawOnly = await request(app)
      .post("/api/v1/receipts")
      .send({ ...receipt, merchantRaw: "Unbekannter Laden" })
      .expect(201);
    expect(rawOnly.body).toMatchObject({
      merchantRaw: "Unbekannter Laden",
      merchantBrand: null,
      merchantStore: null,
    });
    const brandOnly = await request(app)
      .post("/api/v1/receipts")
      .send({ ...receipt, merchantRaw: "EDEKA City", merchantBrandId: brandId })
      .expect(201);
    expect(brandOnly.body.merchantBrand).toMatchObject({
      id: brandId,
      name: "EDEKA",
    });
    expect(brandOnly.body.merchantStore).toBeNull();
    const storeLinked = await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "EDEKA M. Müller e.K.",
        merchantBrandId: brandId,
        merchantStoreId: store.body.id,
      })
      .expect(201);
    expect(storeLinked.body.merchantStore).toMatchObject({
      id: store.body.id,
      brandId,
      name: "EDEKA Müller",
      city: "Berlin",
    });
  });

  it("embeds canonical merchant data in list responses", async () => {
    const brandId = await createBrand("EDEKA");
    await request(app)
      .post("/api/v1/receipts")
      .send({ ...receipt, merchantRaw: "EDEKA City", merchantBrandId: brandId })
      .expect(201);
    const list = await request(app).get("/api/v1/receipts").expect(200);
    expect(list.body.receipts[0]).toMatchObject({
      merchantRaw: "EDEKA City",
      merchantBrand: { id: brandId, name: "EDEKA" },
      merchantStore: null,
    });
  });

  it("rejects a mismatched brand/store pair", async () => {
    const edeka = await createBrand("EDEKA");
    const rewe = await createBrand("REWE");
    const store = await createStore({ brandId: rewe, name: "REWE Nord" });
    const response = await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "REWE Nord",
        merchantBrandId: edeka,
        merchantStoreId: store.body.id,
      })
      .expect(400);
    expect(response.body).toEqual({
      error: {
        code: "validation_error",
        message: "merchantStoreId does not belong to merchantBrandId",
      },
    });
  });

  it("rejects a store without a brand and unknown canonical ids", async () => {
    const brandId = await createBrand("EDEKA");
    const store = await createStore({ brandId, name: "EDEKA Nord" });
    await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "EDEKA Nord",
        merchantStoreId: store.body.id,
      })
      .expect(400);
    await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "EDEKA Nord",
        merchantBrandId: "clx0000000000000000000000",
      })
      .expect(400, {
        error: { code: "validation_error", message: "Unknown merchantBrandId" },
      });
    await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "EDEKA Nord",
        merchantBrandId: brandId,
        merchantStoreId: "clx0000000000000000000000",
      })
      .expect(400, {
        error: { code: "validation_error", message: "Unknown merchantStoreId" },
      });
  });

  it("moves both canonical links together on update", async () => {
    const brandId = await createBrand("EDEKA");
    const store = await createStore({ brandId, name: "EDEKA Nord" });
    const created = await request(app)
      .post("/api/v1/receipts")
      .send({
        ...receipt,
        merchantRaw: "EDEKA Nord",
        merchantBrandId: brandId,
        merchantStoreId: store.body.id,
      })
      .expect(201);
    const id: string = created.body.id;
    // A brand-only patch that leaves the store behind is rejected outright.
    await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({ merchantBrandId: null })
      .expect(400);
    await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({ merchantBrandId: brandId, merchantStoreId: null })
      .expect(200)
      .expect((response) => expect(response.body.merchantStore).toBeNull());
    await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({ merchantBrandId: null, merchantStoreId: null })
      .expect(200)
      .expect((response) => {
        expect(response.body.merchantBrand).toBeNull();
        expect(response.body.merchantStore).toBeNull();
      });
    // Unrelated patches leave canonical identity untouched.
    await request(app)
      .patch(`/api/v1/receipts/${id}`)
      .send({ merchantRaw: "Neuer Rohtext" })
      .expect(200)
      .expect((response) =>
        expect(response.body).toMatchObject({
          merchantRaw: "Neuer Rohtext",
          merchantBrand: null,
        }),
      );
  });

  it("prevents an inconsistent pair from being persisted directly", async () => {
    const edeka = await createBrand("EDEKA");
    const rewe = await createBrand("REWE");
    const store = await createStore({ brandId: rewe, name: "REWE Nord" });
    // The compound (storeId, brandId) relation blocks writes that bypass the API.
    await expect(
      database?.receipt.create({
        data: {
          merchantRaw: "REWE Nord",
          merchantBrandId: edeka,
          merchantStoreId: store.body.id,
          purchaseDate: "2026-07-19",
          totalCents: 100,
        },
      }),
    ).rejects.toThrow();
  });
});
