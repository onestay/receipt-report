-- CreateTable
CREATE TABLE "MerchantBrand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MerchantStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "street" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "normalizedAddressKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MerchantStore_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "MerchantBrand" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchantRaw" TEXT NOT NULL,
    "merchantBrandId" TEXT,
    "merchantStoreId" TEXT,
    "purchaseDate" TEXT NOT NULL,
    "purchaseTime" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "notes" TEXT,
    "totalCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Receipt_merchantBrandId_fkey" FOREIGN KEY ("merchantBrandId") REFERENCES "MerchantBrand" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Receipt_merchantStoreId_merchantBrandId_fkey" FOREIGN KEY ("merchantStoreId", "merchantBrandId") REFERENCES "MerchantStore" ("id", "brandId") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- The former free-form "merchant" column becomes the raw label; canonical
-- brand/store links start empty because no canonical identity existed yet.
INSERT INTO "new_Receipt" ("createdAt", "currency", "id", "merchantRaw", "notes", "purchaseDate", "purchaseTime", "totalCents", "updatedAt") SELECT "createdAt", "currency", "id", "merchant", "notes", "purchaseDate", "purchaseTime", "totalCents", "updatedAt" FROM "Receipt";
DROP TABLE "Receipt";
ALTER TABLE "new_Receipt" RENAME TO "Receipt";
CREATE INDEX "Receipt_purchaseDate_id_idx" ON "Receipt"("purchaseDate", "id");
CREATE INDEX "Receipt_merchantBrandId_idx" ON "Receipt"("merchantBrandId");
CREATE INDEX "Receipt_merchantStoreId_idx" ON "Receipt"("merchantStoreId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "MerchantBrand_normalizedName_key" ON "MerchantBrand"("normalizedName");

-- CreateIndex
CREATE INDEX "MerchantBrand_normalizedName_id_idx" ON "MerchantBrand"("normalizedName", "id");

-- CreateIndex
CREATE INDEX "MerchantStore_brandId_normalizedName_id_idx" ON "MerchantStore"("brandId", "normalizedName", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantStore_brandId_normalizedName_normalizedAddressKey_key" ON "MerchantStore"("brandId", "normalizedName", "normalizedAddressKey");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantStore_id_brandId_key" ON "MerchantStore"("id", "brandId");

