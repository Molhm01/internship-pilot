-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "emailAddress" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "lastSyncAt" DATETIME,
    "lastSyncHistoryId" TEXT,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TrackedEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL,
    "classification" TEXT NOT NULL,
    "matchedJobId" TEXT,
    "matchMethod" TEXT,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AssessmentInboxEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT,
    "sourceEmailId" TEXT,
    "company" TEXT NOT NULL,
    "jobTitle" TEXT,
    "provider" TEXT,
    "deadline" DATETIME,
    "duration" TEXT,
    "link" TEXT,
    "instructions" TEXT,
    "legitimacyNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedEmail_gmailMessageId_key" ON "TrackedEmail"("gmailMessageId");

-- CreateIndex
CREATE INDEX "TrackedEmail_classification_idx" ON "TrackedEmail"("classification");

-- CreateIndex
CREATE INDEX "TrackedEmail_matchedJobId_idx" ON "TrackedEmail"("matchedJobId");

-- CreateIndex
CREATE INDEX "AssessmentInboxEntry_jobId_idx" ON "AssessmentInboxEntry"("jobId");
