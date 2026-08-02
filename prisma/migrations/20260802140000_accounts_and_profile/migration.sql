-- Internship Pilot accounts and the canonical user profile.
--
-- Everything here is additive except one carefully-copied rebuild of
-- ApprovedAnswer, described below. No existing Job, MatchResult,
-- GeneratedDocument, ApplicationRun, ResumeFact or ApplicationProfile row is
-- read, rewritten, or deleted by this migration.
--
-- The password column holds a scrypt hash and never a plaintext password. No
-- employer-site credential is stored anywhere in this database.

CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "displayName" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE TABLE "UserSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

CREATE TABLE "UserProfile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "legalFirstName" TEXT,
  "middleName" TEXT,
  "legalLastName" TEXT,
  "preferredName" TEXT,
  "applicationEmail" TEXT,
  "alternateEmail" TEXT,
  "phone" TEXT,
  "phoneCountryCode" TEXT,
  "addressLine1" TEXT,
  "addressLine2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "linkedinUrl" TEXT,
  "githubUrl" TEXT,
  "portfolioUrl" TEXT,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

CREATE TABLE "Education" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "school" TEXT NOT NULL,
  "degree" TEXT,
  "major" TEXT,
  "minor" TEXT,
  "startMonth" TEXT,
  "startYear" TEXT,
  "graduationMonth" TEXT,
  "graduationYear" TEXT,
  "gpa" TEXT,
  "educationLevel" TEXT,
  "relevantCoursework" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Education_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Education_userId_idx" ON "Education"("userId");

CREATE TABLE "Experience" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "employer" TEXT NOT NULL,
  "title" TEXT,
  "location" TEXT,
  "startDate" TEXT,
  "endDate" TEXT,
  "currentlyEmployed" BOOLEAN NOT NULL DEFAULT false,
  "responsibilities" TEXT,
  "approvedBullets" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Experience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Experience_userId_idx" ON "Experience"("userId");

CREATE TABLE "Project" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startDate" TEXT,
  "endDate" TEXT,
  "technologies" TEXT,
  "description" TEXT,
  "approvedSkills" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

CREATE TABLE "ApplicationPreferences" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "legallyAuthorizedToWork" BOOLEAN,
  "requiresSponsorshipNow" BOOLEAN,
  "mayRequireSponsorshipLater" BOOLEAN,
  "willingToRelocate" BOOLEAN,
  "remotePreference" TEXT,
  "earliestStartDate" TEXT,
  "salaryPreference" TEXT,
  "hasDriversLicense" BOOLEAN,
  "securityClearanceStatus" TEXT,
  "usualJobSource" TEXT,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ApplicationPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ApplicationPreferences_userId_key" ON "ApplicationPreferences"("userId");

CREATE TABLE "SensitiveAnswerPreferences" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "gender" TEXT,
  "raceEthnicity" TEXT,
  "veteranStatus" TEXT,
  "disabilityStatus" TEXT,
  "pronouns" TEXT,
  "declineDemographics" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SensitiveAnswerPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SensitiveAnswerPreferences_userId_key" ON "SensitiveAnswerPreferences"("userId");

-- ApprovedAnswer gains an owner.
--
-- SQLite cannot drop a single-column UNIQUE index in place, so the table is
-- rebuilt. Every existing row is copied with userId NULL, which keeps it
-- readable and editable exactly as before; the row count is asserted by
-- scripts/verify-accounts-migration.mjs.
CREATE TABLE "new_ApprovedAnswer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT,
  "questionText" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ApprovedAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApprovedAnswer" ("id", "questionText", "answer", "createdAt", "updatedAt")
SELECT "id", "questionText", "answer", "createdAt", "updatedAt" FROM "ApprovedAnswer";
DROP TABLE "ApprovedAnswer";
ALTER TABLE "new_ApprovedAnswer" RENAME TO "ApprovedAnswer";
CREATE UNIQUE INDEX "ApprovedAnswer_userId_questionText_key" ON "ApprovedAnswer"("userId", "questionText");
CREATE INDEX "ApprovedAnswer_userId_idx" ON "ApprovedAnswer"("userId");
