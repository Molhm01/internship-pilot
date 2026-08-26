ALTER TABLE "GeneratedDocument"
ADD COLUMN "documentFingerprint" TEXT;

CREATE INDEX "GeneratedDocument_userId_jobId_documentFingerprint_idx"
ON "GeneratedDocument"("userId", "jobId", "documentFingerprint");
