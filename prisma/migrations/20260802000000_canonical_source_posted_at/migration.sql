-- Canonical source posting date for freshness ordering.
--
-- Additive only: six nullable columns and two indexes. No table is rebuilt and
-- no existing row is rewritten, so every Job, MatchResult, GeneratedDocument
-- and ApplicationRun is preserved exactly as it was. `postingDate` is left in
-- place and keeps its current meaning for the posting-date filters.
--
-- Existing rows get sourcePostedAt via scripts/backfill-source-posted-at.ts
-- (npm run backfill:source-posted-at), which copies the already-stored source
-- timestamp rather than inventing one.

ALTER TABLE "Job" ADD COLUMN "sourcePostedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "sourcePostedText" TEXT;
ALTER TABLE "Job" ADD COLUMN "sourceDateConfidence" TEXT;
ALTER TABLE "Job" ADD COLUMN "sourceCapturedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "sourceSyncRunId" TEXT;
ALTER TABLE "Job" ADD COLUMN "sourceRowIndex" INTEGER;

CREATE INDEX "Job_sourcePostedAt_idx" ON "Job"("sourcePostedAt");
CREATE INDEX "Job_sourceSyncRunId_sourceRowIndex_idx" ON "Job"("sourceSyncRunId", "sourceRowIndex");
