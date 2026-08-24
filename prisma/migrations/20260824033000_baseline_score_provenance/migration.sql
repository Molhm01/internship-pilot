-- A Discover score is current only for one user, one approved profile
-- revision, and one canonical job scoring input.  Keep the provenance beside
-- the denormalized display score so refreshes can atomically replace stale AI
-- output with an immediate deterministic baseline instead of clearing it.
ALTER TABLE "UserJobState"
  ADD COLUMN "scoreSource" TEXT,
  ADD COLUMN "scoreProfileRevision" TEXT,
  ADD COLUMN "scoreJobFingerprint" TEXT,
  ADD COLUMN "scoreExplanation" TEXT;

CREATE INDEX "UserJobState_userId_scoreSource_idx"
  ON "UserJobState"("userId", "scoreSource");
