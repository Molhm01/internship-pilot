-- AlterTable
ALTER TABLE "ApplicationProfile" ADD COLUMN "addressCity" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "addressState" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "addressStreet" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "addressZip" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "internshipTermAvailability" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "locationPreferences" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "preferredName" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "previousSchool" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "salaryAnswerPreference" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "willingToRelocate" BOOLEAN;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "atsTenant" TEXT;
ALTER TABLE "Job" ADD COLUMN "atsType" TEXT;
ALTER TABLE "Job" ADD COLUMN "discoverySource" TEXT;
ALTER TABLE "Job" ADD COLUMN "httpStatusAtVerification" INTEGER;
ALTER TABLE "Job" ADD COLUMN "officialJobUrl" TEXT;
ALTER TABLE "Job" ADD COLUMN "redirectChain" TEXT;

-- CreateTable
CREATE TABLE "ApprovedAtsTenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "atsType" TEXT NOT NULL,
    "atsIdentifier" TEXT NOT NULL,
    "discoveredFromCareersUrl" TEXT NOT NULL,
    "evidence" TEXT,
    "approvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovedAtsTenant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NewEmployerReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employerName" TEXT NOT NULL,
    "discoveredFrom" TEXT NOT NULL DEFAULT 'intern-list',
    "guessedCareersUrl" TEXT,
    "guessedDomain" TEXT,
    "sourceJobTitle" TEXT,
    "sourceJobUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SecurityQuarantineEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" TEXT,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ApprovedAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "questionText" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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
    "contentHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "allowlisted" BOOLEAN NOT NULL DEFAULT true,
    "csvSector" TEXT,
    "csvCareerDomain" TEXT,
    "csvEeCpeFit" TEXT,
    "csvVerificationStatus" TEXT,
    "csvVerificationBasis" TEXT,
    "csvVerifiedDate" DATETIME,
    "csvRecommendedSearchTerms" TEXT,
    "csvCanonicalApplyRule" TEXT
);
INSERT INTO "new_Company" ("activeInternshipCount", "atsIdentifier", "atsType", "careersUrl", "consecutiveFailures", "createdAt", "id", "industry", "lastCheckError", "lastCheckStatus", "lastCheckedAt", "lastETag", "lastModified", "locations", "monitoringStatus", "name", "nextCheckAt", "priority", "source", "updatedAt", "website") SELECT "activeInternshipCount", "atsIdentifier", "atsType", "careersUrl", "consecutiveFailures", "createdAt", "id", "industry", "lastCheckError", "lastCheckStatus", "lastCheckedAt", "lastETag", "lastModified", "locations", "monitoringStatus", "name", "nextCheckAt", "priority", "source", "updatedAt", "website" FROM "Company";
DROP TABLE "Company";
ALTER TABLE "new_Company" RENAME TO "Company";
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");
CREATE INDEX "Company_atsType_idx" ON "Company"("atsType");
CREATE INDEX "Company_nextCheckAt_idx" ON "Company"("nextCheckAt");
CREATE INDEX "Company_priority_idx" ON "Company"("priority");
CREATE INDEX "Company_allowlisted_idx" ON "Company"("allowlisted");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedAtsTenant_companyId_atsType_atsIdentifier_key" ON "ApprovedAtsTenant"("companyId", "atsType", "atsIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "NewEmployerReview_employerName_key" ON "NewEmployerReview"("employerName");

-- CreateIndex
CREATE INDEX "SecurityQuarantineEntry_jobId_idx" ON "SecurityQuarantineEntry"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedAnswer_questionText_key" ON "ApprovedAnswer"("questionText");
