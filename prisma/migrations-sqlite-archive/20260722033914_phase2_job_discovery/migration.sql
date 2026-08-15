-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "newJobsCount" INTEGER NOT NULL DEFAULT 0,
    "updatedJobsCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT
);

-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "filterJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
    "status" TEXT NOT NULL DEFAULT 'Discovered',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "source" TEXT,
    "sourceJobId" TEXT,
    "sourceUrl" TEXT,
    "workplaceType" TEXT,
    "firstSeenAt" DATETIME,
    "lastSeenAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "compensation" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'Unverified',
    "verificationReason" TEXT,
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
INSERT INTO "new_Job" ("company", "createdAt", "description", "duration", "id", "internshipTerm", "location", "postingDate", "status", "title", "updatedAt", "url") SELECT "company", "createdAt", "description", "duration", "id", "internshipTerm", "location", "postingDate", "status", "title", "updatedAt", "url" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_source_sourceJobId_idx" ON "Job"("source", "sourceJobId");
CREATE INDEX "Job_verificationStatus_idx" ON "Job"("verificationStatus");
CREATE TABLE "new_MatchResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "eligibilityReason" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL DEFAULT 'Consider',
    "skillsSupported" TEXT NOT NULL,
    "skillsNeedConfirmation" TEXT NOT NULL,
    "skillsToLearn" TEXT NOT NULL,
    "skillsNeverAdd" TEXT NOT NULL,
    "tailoringPreview" TEXT,
    "factsUsed" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MatchResult" ("createdAt", "eligibility", "eligibilityReason", "explanation", "factsUsed", "id", "jobId", "score", "skillsNeedConfirmation", "skillsNeverAdd", "skillsSupported", "skillsToLearn") SELECT "createdAt", "eligibility", "eligibilityReason", "explanation", "factsUsed", "id", "jobId", "score", "skillsNeedConfirmation", "skillsNeverAdd", "skillsSupported", "skillsToLearn" FROM "MatchResult";
DROP TABLE "MatchResult";
ALTER TABLE "new_MatchResult" RENAME TO "MatchResult";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SavedFilter_name_key" ON "SavedFilter"("name");
