-- Official employer/ATS sources become the primary discovery database.
-- All changes are additive; existing jobs and signal history are preserved.

ALTER TABLE "Company"
  ADD COLUMN "boardSnapshot" TEXT,
  ADD COLUMN "lastSuccessfulBoardAt" TIMESTAMP(3),
  ADD COLUMN "lastBoardQueryMs" INTEGER;

ALTER TABLE "FreshSignalResolution"
  ADD COLUMN "workflowState" TEXT NOT NULL DEFAULT 'SIGNAL_SEEN';

ALTER TABLE "Job"
  ADD COLUMN "sourceDateProvenance" TEXT,
  ADD COLUMN "consecutiveBoardMisses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "boardMissingSince" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3);

UPDATE "Job"
SET "sourceDateProvenance" = CASE
  WHEN "sourcePostedAt" IS NULL THEN 'UNKNOWN'
  WHEN lower(coalesce("source", '')) IN (
    'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'icims',
    'successfactors', 'eightfold', 'phenom', 'usajobs'
  ) AND "sourceDateConfidence" = 'EXACT' THEN 'EMPLOYER_ATS_EXACT'
  WHEN lower(coalesce("source", '')) IN (
    'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'icims',
    'successfactors', 'eightfold', 'phenom', 'usajobs'
  ) THEN 'EMPLOYER_ATS_DATE'
  WHEN "sourceDateConfidence" = 'EXACT' THEN 'TRUSTED_RADAR_EXACT'
  ELSE 'TRUSTED_RADAR_RELATIVE'
END;

CREATE TABLE "OfficialBoardPoll" (
  "id" TEXT NOT NULL,
  "companyId" TEXT,
  "companyName" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL,
  "jobsScanned" INTEGER NOT NULL DEFAULT 0,
  "engineeringInternshipsFound" INTEGER NOT NULL DEFAULT 0,
  "newJobs" INTEGER NOT NULL DEFAULT 0,
  "updatedJobs" INTEGER NOT NULL DEFAULT 0,
  "missingJobs" INTEGER NOT NULL DEFAULT 0,
  "closedJobs" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  CONSTRAINT "OfficialBoardPoll_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfficialBoardPoll_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "FreshSignalResolution_workflowState_nextAttemptAt_idx"
  ON "FreshSignalResolution"("workflowState", "nextAttemptAt");
CREATE INDEX "FreshSignalResolution_resolvedJobId_idx"
  ON "FreshSignalResolution"("resolvedJobId");
CREATE INDEX "OfficialBoardPoll_provider_startedAt_idx"
  ON "OfficialBoardPoll"("provider", "startedAt");
CREATE INDEX "OfficialBoardPoll_companyId_startedAt_idx"
  ON "OfficialBoardPoll"("companyId", "startedAt");
CREATE INDEX "OfficialBoardPoll_status_startedAt_idx"
  ON "OfficialBoardPoll"("status", "startedAt");

UPDATE "FreshSignalResolution"
SET "workflowState" = CASE
  WHEN "state" = 'RESOLVED' THEN 'OFFICIAL_RESOLVED'
  WHEN "state" = 'CLOSED' THEN 'PERMANENT_FAILURE'
  ELSE 'NO_MATCH_YET'
END;
