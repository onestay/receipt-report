CREATE TABLE "CategorySuggestionRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "description" TEXT NOT NULL,
    "normalizedDescription" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeSpecificity" INTEGER NOT NULL,
    "scopeIdentity" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "brandId" TEXT,
    "storeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CategorySuggestionRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CategorySuggestionRule_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "MerchantBrand" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CategorySuggestionRule_storeId_brandId_fkey" FOREIGN KEY ("storeId", "brandId") REFERENCES "MerchantStore" ("id", "brandId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CategorySuggestionRule_scope_check" CHECK (
      ("scopeKind" = 'global' AND "scopeSpecificity" = 0 AND "brandId" IS NULL AND "storeId" IS NULL AND "scopeIdentity" = 'global')
      OR ("scopeKind" = 'brand' AND "scopeSpecificity" = 1 AND "brandId" IS NOT NULL AND "storeId" IS NULL AND "scopeIdentity" = "brandId")
      OR ("scopeKind" = 'store' AND "scopeSpecificity" = 2 AND "brandId" IS NOT NULL AND "storeId" IS NOT NULL AND "scopeIdentity" = "storeId")
    )
);

CREATE UNIQUE INDEX "CategorySuggestionRule_scope_description_key"
ON "CategorySuggestionRule"("normalizedDescription", "scopeKind", "scopeIdentity");
CREATE INDEX "CategorySuggestionRule_normalizedDescription_scopeSpecificity_id_idx"
ON "CategorySuggestionRule"("normalizedDescription", "scopeSpecificity", "id");
CREATE INDEX "CategorySuggestionRule_categoryId_idx" ON "CategorySuggestionRule"("categoryId");
CREATE INDEX "CategorySuggestionRule_brandId_idx" ON "CategorySuggestionRule"("brandId");
CREATE INDEX "CategorySuggestionRule_storeId_idx" ON "CategorySuggestionRule"("storeId");
