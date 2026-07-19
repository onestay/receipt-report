PRAGMA foreign_keys=OFF;

CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant" TEXT NOT NULL,
    "purchaseDate" TEXT NOT NULL,
    "purchaseTime" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "notes" TEXT,
    "totalCents" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "LineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantityMilli" INTEGER,
    "unitPriceCents" INTEGER,
    "lineTotalCents" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "LineItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Receipt_purchaseDate_id_idx" ON "Receipt"("purchaseDate", "id");
CREATE INDEX "LineItem_receiptId_idx" ON "LineItem"("receiptId");
CREATE UNIQUE INDEX "LineItem_receiptId_position_key" ON "LineItem"("receiptId", "position");

PRAGMA foreign_keys=ON;
