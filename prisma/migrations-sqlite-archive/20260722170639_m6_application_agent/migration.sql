-- CreateTable
CREATE TABLE "ApplicationRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "atsType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "currentStep" TEXT,
    "needsUserActionReason" TEXT,
    "resumeDocumentId" TEXT,
    "coverLetterDocumentId" TEXT,
    "matchScoreAtRun" INTEGER,
    "answers" TEXT,
    "confirmationNumber" TEXT,
    "confirmationUrl" TEXT,
    "screenshotPath" TEXT,
    "browserLogPath" TEXT,
    "errorLog" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplicationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ApplicationRun_jobId_idx" ON "ApplicationRun"("jobId");

-- CreateIndex
CREATE INDEX "ApplicationRun_status_idx" ON "ApplicationRun"("status");

-- CreateIndex
CREATE INDEX "AuditLogEntry_jobId_idx" ON "AuditLogEntry"("jobId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_createdAt_idx" ON "AuditLogEntry"("createdAt");
