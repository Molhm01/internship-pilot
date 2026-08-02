-- AlterTable
ALTER TABLE "Job" ADD COLUMN "requisitionId" TEXT;

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "website" TEXT,
    "careersUrl" TEXT,
    "atsType" TEXT,
    "atsIdentifier" TEXT,
    "locations" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'standard',
    "lastCheckedAt" DATETIME,
    "nextCheckAt" DATETIME,
    "activeInternshipCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "monitoringStatus" TEXT NOT NULL DEFAULT 'active',
    "lastCheckStatus" TEXT,
    "lastCheckError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Company_atsType_idx" ON "Company"("atsType");

-- CreateIndex
CREATE INDEX "Company_nextCheckAt_idx" ON "Company"("nextCheckAt");

-- CreateIndex
CREATE INDEX "Company_priority_idx" ON "Company"("priority");
