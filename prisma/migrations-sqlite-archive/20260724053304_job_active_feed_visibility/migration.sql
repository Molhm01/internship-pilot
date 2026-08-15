-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "postingDate" DATETIME,
    "internshipTerm" TEXT,
    "duration" TEXT,
    "url" TEXT,
    "description" TEXT NOT NULL,
    "jobDescriptionSourceUrl" TEXT,
    "jobDescriptionHash" TEXT,
    "jobDescriptionCapturedAt" DATETIME,
    "jobResponsibilities" TEXT,
    "jobQualifications" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "source" TEXT,
    "sourceJobId" TEXT,
    "requisitionId" TEXT,
    "sourceUrl" TEXT,
    "workplaceType" TEXT,
    "firstSeenAt" DATETIME,
    "lastSeenAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "compensation" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'Unverified',
    "verificationReason" TEXT,
    "verificationMethod" TEXT,
    "officialEmployerDomain" TEXT,
    "evidence" TEXT,
    "matchScore" INTEGER,
    "eligibilityStatus" TEXT,
    "discoverySource" TEXT,
    "atsType" TEXT,
    "atsTenant" TEXT,
    "redirectChain" TEXT,
    "httpStatusAtVerification" INTEGER,
    "officialJobUrl" TEXT,
    "officialApplyUrl" TEXT,
    "activeFeed" BOOLEAN NOT NULL DEFAULT false,
    "disciplineTags" TEXT,
    "sophomoreEligible" BOOLEAN,
    "graduationYears" TEXT,
    "sponsorship" TEXT,
    "citizenshipOrClearance" BOOLEAN,
    "compMinHourly" REAL,
    "compMaxHourly" REAL,
    "season" TEXT,
    "distanceMilesFromClifton" REAL
);
INSERT INTO "new_Job" ("atsTenant", "atsType", "citizenshipOrClearance", "compMaxHourly", "compMinHourly", "company", "compensation", "createdAt", "description", "disciplineTags", "discoverySource", "distanceMilesFromClifton", "duration", "eligibilityStatus", "evidence", "firstSeenAt", "graduationYears", "httpStatusAtVerification", "id", "internshipTerm", "jobDescriptionCapturedAt", "jobDescriptionHash", "jobDescriptionSourceUrl", "jobQualifications", "jobResponsibilities", "lastSeenAt", "lastVerifiedAt", "location", "matchScore", "officialApplyUrl", "officialEmployerDomain", "officialJobUrl", "postingDate", "redirectChain", "requisitionId", "season", "sophomoreEligible", "source", "sourceJobId", "sourceUrl", "sponsorship", "status", "title", "updatedAt", "url", "verificationMethod", "verificationReason", "verificationStatus", "workplaceType") SELECT "atsTenant", "atsType", "citizenshipOrClearance", "compMaxHourly", "compMinHourly", "company", "compensation", "createdAt", "description", "disciplineTags", "discoverySource", "distanceMilesFromClifton", "duration", "eligibilityStatus", "evidence", "firstSeenAt", "graduationYears", "httpStatusAtVerification", "id", "internshipTerm", "jobDescriptionCapturedAt", "jobDescriptionHash", "jobDescriptionSourceUrl", "jobQualifications", "jobResponsibilities", "lastSeenAt", "lastVerifiedAt", "location", "matchScore", "officialApplyUrl", "officialEmployerDomain", "officialJobUrl", "postingDate", "redirectChain", "requisitionId", "season", "sophomoreEligible", "source", "sourceJobId", "sourceUrl", "sponsorship", "status", "title", "updatedAt", "url", "verificationMethod", "verificationReason", "verificationStatus", "workplaceType" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_source_sourceJobId_idx" ON "Job"("source", "sourceJobId");
CREATE INDEX "Job_verificationStatus_idx" ON "Job"("verificationStatus");
CREATE INDEX "Job_activeFeed_idx" ON "Job"("activeFeed");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Backfill Active-feed VISIBILITY for existing rows, applying the same policy
-- as src/lib/jobs/sourcePolicy.ts (computeActiveFeed). This changes ONLY the
-- new activeFeed column — verificationStatus and all other data are untouched,
-- so making trapped listings visible does not alter their verification state.
-- (scripts/backfill-active-feed.ts re-applies the exact policy idempotently
-- after migration, including the full demo/fixture exclusion.)
UPDATE "Job" SET "activeFeed" = 1
WHERE "verificationStatus" NOT IN ('SecurityQuarantine')
  AND lower("company") NOT LIKE '%mock ats test%'
  AND lower("company") NOT LIKE '%test documents co%'
  AND lower("company") NOT LIKE '%fixture%'
  AND lower("company") NOT LIKE '%demo company%'
  AND (
    "verificationStatus" = 'VERIFIED_OFFICIAL_AT_LAST_CHECK'
    OR (
      "verificationStatus" NOT IN ('Closed')
      AND (
        lower("source") LIKE '%jobright%'
        OR lower("source") LIKE '%simplify%'
        OR (lower("source") LIKE '%intern%' AND lower("source") LIKE '%list%')
      )
    )
  );
