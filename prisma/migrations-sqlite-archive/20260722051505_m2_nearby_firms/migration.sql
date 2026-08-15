-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NearbyFirm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "placeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "address" TEXT,
    "latitude" REAL,
    "longitude" REAL,
    "distanceMiles" REAL,
    "website" TEXT,
    "careersUrl" TEXT,
    "atsType" TEXT,
    "atsIdentifier" TEXT,
    "companyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "discoveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "NearbyFirm_placeId_key" ON "NearbyFirm"("placeId");
