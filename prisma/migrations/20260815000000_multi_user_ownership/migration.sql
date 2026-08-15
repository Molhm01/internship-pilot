-- Multi-user ownership.
--
-- Internship Pilot was built for one person on one machine. This migration is
-- the structural half of making it safe for many: every private row gains an
-- owner, per-person state comes off the shared Job row, and Better Auth's
-- tables arrive alongside the existing User table rather than replacing it.
--
-- It is deliberately ADDITIVE. There is no DROP TABLE and no DROP COLUMN in
-- this file. The four dropped indexes are global uniqueness constraints on
-- private data — one saved filter named "X" for the whole installation, one
-- company-relationship row per employer — being replaced by the per-user
-- constraint that should always have been there. Nothing they protected is
-- lost; the same rows satisfy the new constraints.
--
-- New ownership columns are NULLABLE on purpose. The rows already in this
-- database belong to the original user, whose account may not exist yet, and a
-- NOT NULL column cannot be added to a populated table without inventing an
-- owner. Ownership is assigned by scripts/claim-legacy-user-data.ts, run once
-- against an explicit user id. A follow-up migration tightens the columns to
-- NOT NULL after that has run and been verified.
--
-- Canonical Job, Company, ApprovedAtsTenant, verification and discovery rows
-- are untouched: they are shared by every user and this migration does not
-- read, rewrite or delete one of them.

-- DropIndex
DROP INDEX "CompanyRelationshipFact_companyKey_key";

-- DropIndex
DROP INDEX "InitialAiMatchJob_jobId_matchType_key";

-- DropIndex
DROP INDEX "SavedFilter_name_key";

-- DropIndex
DROP INDEX "TrackedEmail_gmailMessageId_key";

-- AlterTable
ALTER TABLE "ApplicationRun" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "AssessmentInboxEntry" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "AuditLogEntry" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "CompanyRelationshipFact" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "GeneratedDocument" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "GmailAccount" ADD COLUMN     "userId" TEXT,
ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "InitialAiMatchJob" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "MatchResult" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "ResumeBullet" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "ResumeDocument" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "ResumeFact" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "SavedFilter" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "TrackedEmail" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "image" TEXT,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserJobState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "applicationStatus" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "matchScore" INTEGER,
    "eligibilityStatus" TEXT,
    "matchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserJobState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSetting" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSetting_pkey" PRIMARY KEY ("userId","key")
);

-- CreateTable
CREATE TABLE "ExtensionToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Browser extension',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtensionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_providerId_accountId_key" ON "Account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "Verification_identifier_idx" ON "Verification"("identifier");

-- CreateIndex
CREATE INDEX "UserJobState_userId_idx" ON "UserJobState"("userId");

-- CreateIndex
CREATE INDEX "UserJobState_jobId_idx" ON "UserJobState"("jobId");

-- CreateIndex
CREATE INDEX "UserJobState_userId_applicationStatus_idx" ON "UserJobState"("userId", "applicationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "UserJobState_userId_jobId_key" ON "UserJobState"("userId", "jobId");

-- CreateIndex
CREATE INDEX "UserSetting_userId_idx" ON "UserSetting"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtensionToken_tokenHash_key" ON "ExtensionToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ExtensionToken_userId_idx" ON "ExtensionToken"("userId");

-- CreateIndex
CREATE INDEX "ApplicationRun_userId_idx" ON "ApplicationRun"("userId");

-- CreateIndex
CREATE INDEX "ApplicationRun_userId_jobId_idx" ON "ApplicationRun"("userId", "jobId");

-- CreateIndex
CREATE INDEX "AssessmentInboxEntry_userId_idx" ON "AssessmentInboxEntry"("userId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_userId_idx" ON "AuditLogEntry"("userId");

-- CreateIndex
CREATE INDEX "CompanyRelationshipFact_userId_idx" ON "CompanyRelationshipFact"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRelationshipFact_userId_companyKey_key" ON "CompanyRelationshipFact"("userId", "companyKey");

-- CreateIndex
CREATE INDEX "GeneratedDocument_userId_idx" ON "GeneratedDocument"("userId");

-- CreateIndex
CREATE INDEX "GeneratedDocument_userId_jobId_idx" ON "GeneratedDocument"("userId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "GmailAccount_userId_key" ON "GmailAccount"("userId");

-- CreateIndex
CREATE INDEX "InitialAiMatchJob_userId_idx" ON "InitialAiMatchJob"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InitialAiMatchJob_userId_jobId_matchType_key" ON "InitialAiMatchJob"("userId", "jobId", "matchType");

-- CreateIndex
CREATE INDEX "MatchResult_userId_idx" ON "MatchResult"("userId");

-- CreateIndex
CREATE INDEX "MatchResult_userId_jobId_idx" ON "MatchResult"("userId", "jobId");

-- CreateIndex
CREATE INDEX "ResumeBullet_userId_idx" ON "ResumeBullet"("userId");

-- CreateIndex
CREATE INDEX "ResumeDocument_userId_idx" ON "ResumeDocument"("userId");

-- CreateIndex
CREATE INDEX "ResumeFact_userId_idx" ON "ResumeFact"("userId");

-- CreateIndex
CREATE INDEX "SavedFilter_userId_idx" ON "SavedFilter"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedFilter_userId_name_key" ON "SavedFilter"("userId", "name");

-- CreateIndex
CREATE INDEX "TrackedEmail_userId_idx" ON "TrackedEmail"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedEmail_userId_gmailMessageId_key" ON "TrackedEmail"("userId", "gmailMessageId");

-- AddForeignKey
ALTER TABLE "ResumeFact" ADD CONSTRAINT "ResumeFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeDocument" ADD CONSTRAINT "ResumeDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResumeBullet" ADD CONSTRAINT "ResumeBullet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRelationshipFact" ADD CONSTRAINT "CompanyRelationshipFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitialAiMatchJob" ADD CONSTRAINT "InitialAiMatchJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedFilter" ADD CONSTRAINT "SavedFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GmailAccount" ADD CONSTRAINT "GmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedEmail" ADD CONSTRAINT "TrackedEmail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentInboxEntry" ADD CONSTRAINT "AssessmentInboxEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobState" ADD CONSTRAINT "UserJobState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserJobState" ADD CONSTRAINT "UserJobState_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSetting" ADD CONSTRAINT "UserSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionToken" ADD CONSTRAINT "ExtensionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Data preservation
-- ===========================================================================

-- Better Auth requires a non-empty display name. Existing accounts carry it in
-- the older `displayName` column, so copy it across; anyone who never set one
-- gets the local part of their email rather than a blank heading.
UPDATE "User"
SET "name" = COALESCE(NULLIF(TRIM("displayName"), ''), split_part("email", '@', 1))
WHERE "name" = '';

-- Move each existing password into the credential account row Better Auth
-- reads. The hash is copied verbatim — it is the same scrypt encoding, which
-- src/lib/auth/betterAuth.ts keeps as the hash/verify implementation — so every
-- existing user signs in afterwards with the password they already have, and
-- nobody is forced through a reset.
--
-- `User.passwordHash` is left in place. It is now unread, and deleting the only
-- prior copy of a credential in the same migration that copies it is not a
-- trade worth making.
INSERT INTO "Account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
SELECT
    md5(random()::text || clock_timestamp()::text || "id"),
    "id",
    'credential',
    "id",
    "passwordHash",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "User"
WHERE "passwordHash" IS NOT NULL
  AND "passwordHash" <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "Account" a WHERE a."userId" = "User"."id" AND a."providerId" = 'credential'
  );
