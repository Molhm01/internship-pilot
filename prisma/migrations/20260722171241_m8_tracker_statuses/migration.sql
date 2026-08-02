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
INSERT INTO "new_Job" ("citizenshipOrClearance", "compMaxHourly", "compMinHourly", "company", "compensation", "createdAt", "description", "disciplineTags", "distanceMilesFromClifton", "duration", "eligibilityStatus", "evidence", "firstSeenAt", "graduationYears", "id", "internshipTerm", "lastSeenAt", "lastVerifiedAt", "location", "matchScore", "officialEmployerDomain", "postingDate", "requisitionId", "season", "sophomoreEligible", "source", "sourceJobId", "sourceUrl", "sponsorship", "status", "title", "updatedAt", "url", "verificationMethod", "verificationReason", "verificationStatus", "workplaceType") SELECT "citizenshipOrClearance", "compMaxHourly", "compMinHourly", "company", "compensation", "createdAt", "description", "disciplineTags", "distanceMilesFromClifton", "duration", "eligibilityStatus", "evidence", "firstSeenAt", "graduationYears", "id", "internshipTerm", "lastSeenAt", "lastVerifiedAt", "location", "matchScore", "officialEmployerDomain", "postingDate", "requisitionId", "season", "sophomoreEligible", "source", "sourceJobId", "sourceUrl", "sponsorship", "status", "title", "updatedAt", "url", "verificationMethod", "verificationReason", "verificationStatus", "workplaceType" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";

-- Milestone 8: rename the Phase 1 tracker vocabulary to the new set.
-- "Saved" -> VERIFIED (closest new-vocab equivalent to "user is tracking this
-- one, not yet tailoring") and "Withdrawn" -> CLOSED (closed out by the
-- candidate) are the only two without a same-meaning direct rename; every
-- other value maps 1:1 in spirit.
UPDATE "Job" SET "status" = 'DISCOVERED' WHERE "status" = 'Discovered';
UPDATE "Job" SET "status" = 'VERIFIED' WHERE "status" = 'Saved';
UPDATE "Job" SET "status" = 'TAILORING' WHERE "status" = 'Tailoring';
UPDATE "Job" SET "status" = 'READY_TO_APPLY' WHERE "status" = 'Ready';
UPDATE "Job" SET "status" = 'SUBMITTED' WHERE "status" = 'Submitted';
UPDATE "Job" SET "status" = 'ASSESSMENT_REQUIRED' WHERE "status" = 'Assessment';
UPDATE "Job" SET "status" = 'INTERVIEW' WHERE "status" = 'Interview';
UPDATE "Job" SET "status" = 'REJECTED' WHERE "status" = 'Rejected';
UPDATE "Job" SET "status" = 'OFFER' WHERE "status" = 'Offer';
UPDATE "Job" SET "status" = 'CLOSED' WHERE "status" = 'Withdrawn';
CREATE INDEX "Job_source_sourceJobId_idx" ON "Job"("source", "sourceJobId");
CREATE INDEX "Job_verificationStatus_idx" ON "Job"("verificationStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
