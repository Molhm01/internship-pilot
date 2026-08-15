ALTER TABLE "MatchResult" ADD COLUMN "origin" TEXT;

CREATE TABLE "InitialAiMatchJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "matchType" TEXT NOT NULL DEFAULT 'INITIAL',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" DATETIME,
    "lastErrorCode" TEXT,
    "matchResultId" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InitialAiMatchJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InitialAiMatchJob_matchResultId_fkey" FOREIGN KEY ("matchResultId") REFERENCES "MatchResult" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "InitialAiMatchJob_matchResultId_key" ON "InitialAiMatchJob"("matchResultId");
CREATE UNIQUE INDEX "InitialAiMatchJob_jobId_matchType_key" ON "InitialAiMatchJob"("jobId", "matchType");
CREATE INDEX "InitialAiMatchJob_state_nextAttemptAt_idx" ON "InitialAiMatchJob"("state", "nextAttemptAt");
