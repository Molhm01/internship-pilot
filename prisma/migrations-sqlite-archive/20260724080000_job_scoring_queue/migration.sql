-- AlterTable
ALTER TABLE "Job" ADD COLUMN "scoringState" TEXT NOT NULL DEFAULT 'NOT_SCORED';
ALTER TABLE "Job" ADD COLUMN "scoringPriority" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Job" ADD COLUMN "scoringError" TEXT;
ALTER TABLE "Job" ADD COLUMN "scoringQueuedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "scoringStartedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "scoringFinishedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "scoringHeartbeatAt" DATETIME;

-- CreateIndex
CREATE INDEX "Job_scoringState_idx" ON "Job"("scoringState");
