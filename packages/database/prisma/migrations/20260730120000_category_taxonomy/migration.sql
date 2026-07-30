-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "parentId" TEXT,
    "position" INTEGER NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Add the nullable category assignment without losing existing line-item data.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "categoryId" TEXT,
    "description" TEXT NOT NULL,
    "quantityMilli" INTEGER,
    "unitPriceCents" INTEGER,
    "lineTotalCents" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "LineItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LineItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_LineItem" ("description", "id", "lineTotalCents", "position", "quantityMilli", "receiptId", "unitPriceCents")
SELECT "description", "id", "lineTotalCents", "position", "quantityMilli", "receiptId", "unitPriceCents" FROM "LineItem";
DROP TABLE "LineItem";
ALTER TABLE "new_LineItem" RENAME TO "LineItem";
CREATE UNIQUE INDEX "LineItem_receiptId_position_key" ON "LineItem"("receiptId", "position");
CREATE INDEX "LineItem_receiptId_idx" ON "LineItem"("receiptId");
CREATE INDEX "LineItem_categoryId_idx" ON "LineItem"("categoryId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- SQLite permits multiple NULL values in a normal compound unique index.
-- Coalescing the nullable parent gives top-level rows the same sibling-name and
-- position guarantees as children.
CREATE UNIQUE INDEX "Category_sibling_name_key"
ON "Category"(COALESCE("parentId", ''), "normalizedName");
CREATE UNIQUE INDEX "Category_sibling_position_key"
ON "Category"(COALESCE("parentId", ''), "position");
CREATE INDEX "Category_parentId_normalizedName_idx" ON "Category"("parentId", "normalizedName");
CREATE INDEX "Category_parentId_position_id_idx" ON "Category"("parentId", "position", "id");

-- Starter rows are ordinary mutable categories. Prisma's migration ledger is
-- the only seeding guard, so renamed or deleted starters never reappear.
INSERT INTO "Category" ("id", "name", "normalizedName", "parentId", "position", "updatedAt") VALUES
('cm00000000000000000000001', 'Food', 'food', NULL, 0, CURRENT_TIMESTAMP),
('cm00000000000000000000002', 'Household', 'household', NULL, 1, CURRENT_TIMESTAMP),
('cm00000000000000000000003', 'Personal care', 'personal care', NULL, 2, CURRENT_TIMESTAMP),
('cm00000000000000000000004', 'Eating out', 'eating out', NULL, 3, CURRENT_TIMESTAMP),
('cm00000000000000000000005', 'Health', 'health', NULL, 4, CURRENT_TIMESTAMP),
('cm00000000000000000000006', 'Pets', 'pets', NULL, 5, CURRENT_TIMESTAMP),
('cm00000000000000000000007', 'Baby', 'baby', NULL, 6, CURRENT_TIMESTAMP),
('cm00000000000000000000008', 'Clothing', 'clothing', NULL, 7, CURRENT_TIMESTAMP),
('cm00000000000000000000009', 'Electronics', 'electronics', NULL, 8, CURRENT_TIMESTAMP),
('cm00000000000000000000010', 'Other', 'other', NULL, 9, CURRENT_TIMESTAMP),
('cm00000000000000000000011', 'Fruit & vegetables', 'fruit & vegetables', 'cm00000000000000000000001', 0, CURRENT_TIMESTAMP),
('cm00000000000000000000012', 'Meat & fish', 'meat & fish', 'cm00000000000000000000001', 1, CURRENT_TIMESTAMP),
('cm00000000000000000000013', 'Dairy & eggs', 'dairy & eggs', 'cm00000000000000000000001', 2, CURRENT_TIMESTAMP),
('cm00000000000000000000014', 'Bakery', 'bakery', 'cm00000000000000000000001', 3, CURRENT_TIMESTAMP),
('cm00000000000000000000015', 'Pantry & cooking', 'pantry & cooking', 'cm00000000000000000000001', 4, CURRENT_TIMESTAMP),
('cm00000000000000000000016', 'Snacks & sweets', 'snacks & sweets', 'cm00000000000000000000001', 5, CURRENT_TIMESTAMP),
('cm00000000000000000000017', 'Drinks', 'drinks', 'cm00000000000000000000001', 6, CURRENT_TIMESTAMP),
('cm00000000000000000000018', 'Alcohol', 'alcohol', 'cm00000000000000000000001', 7, CURRENT_TIMESTAMP),
('cm00000000000000000000019', 'Cleaning', 'cleaning', 'cm00000000000000000000002', 0, CURRENT_TIMESTAMP),
('cm00000000000000000000020', 'Paper goods', 'paper goods', 'cm00000000000000000000002', 1, CURRENT_TIMESTAMP),
('cm00000000000000000000021', 'Home & kitchen supplies', 'home & kitchen supplies', 'cm00000000000000000000002', 2, CURRENT_TIMESTAMP),
('cm00000000000000000000022', 'Hygiene', 'hygiene', 'cm00000000000000000000003', 0, CURRENT_TIMESTAMP),
('cm00000000000000000000023', 'Cosmetics', 'cosmetics', 'cm00000000000000000000003', 1, CURRENT_TIMESTAMP),
('cm00000000000000000000024', 'Hair care', 'hair care', 'cm00000000000000000000003', 2, CURRENT_TIMESTAMP);
