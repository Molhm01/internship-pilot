-- Canonical verification model: single clean reason code on the job, plus an
-- append-only per-attempt history table. Additive and non-destructive.

-- One clean machine reason code for the CURRENT state (never a concatenation).
ALTER TABLE "Job" ADD COLUMN "reasonCode" TEXT;

-- Append-only history of every verification/re-verification attempt.
CREATE TABLE "VerificationAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerificationAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "VerificationAttempt_jobId_idx" ON "VerificationAttempt"("jobId");
CREATE INDEX "VerificationAttempt_attemptedAt_idx" ON "VerificationAttempt"("attemptedAt");
