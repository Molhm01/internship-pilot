ALTER TABLE "Company"
  ADD COLUMN "atsConfigState" TEXT NOT NULL DEFAULT 'UNTESTED',
  ADD COLUMN "atsConfigCheckedAt" TIMESTAMP(3),
  ADD COLUMN "atsValidatedAt" TIMESTAMP(3),
  ADD COLUMN "atsConfigErrorCode" TEXT,
  ADD COLUMN "atsConfigEvidence" TEXT,
  ADD COLUMN "engineeringActivityTier" TEXT NOT NULL DEFAULT 'C',
  ADD COLUMN "lastEngineeringInternshipAt" TIMESTAMP(3);

ALTER TABLE "Job"
  ADD COLUMN "officialFirstSeenAt" TIMESTAMP(3),
  ADD COLUMN "discoveryPipeline" TEXT;

ALTER TABLE "OfficialBoardPoll"
  ADD COLUMN "totalAvailableJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "configState" TEXT,
  ADD COLUMN "paginationVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fullJdJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "exactTimestampJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dateOnlyJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relativeParsedJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "radarFallbackJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "unknownTimestampJobs" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Company_atsConfigState_idx" ON "Company"("atsConfigState");
CREATE INDEX "Company_engineeringActivityTier_idx" ON "Company"("engineeringActivityTier");
CREATE INDEX "Job_discoveryPipeline_officialFirstSeenAt_idx" ON "Job"("discoveryPipeline", "officialFirstSeenAt");
