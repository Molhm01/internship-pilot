-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Company" (
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
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastETag" TEXT,
    "lastModified" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Company" ("activeInternshipCount", "atsIdentifier", "atsType", "careersUrl", "createdAt", "id", "industry", "lastCheckError", "lastCheckStatus", "lastCheckedAt", "locations", "monitoringStatus", "name", "nextCheckAt", "priority", "source", "updatedAt", "website") SELECT "activeInternshipCount", "atsIdentifier", "atsType", "careersUrl", "createdAt", "id", "industry", "lastCheckError", "lastCheckStatus", "lastCheckedAt", "locations", "monitoringStatus", "name", "nextCheckAt", "priority", "source", "updatedAt", "website" FROM "Company";
DROP TABLE "Company";
ALTER TABLE "new_Company" RENAME TO "Company";
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");
CREATE INDEX "Company_atsType_idx" ON "Company"("atsType");
CREATE INDEX "Company_nextCheckAt_idx" ON "Company"("nextCheckAt");
CREATE INDEX "Company_priority_idx" ON "Company"("priority");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
