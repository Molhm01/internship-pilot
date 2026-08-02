-- The canonical application profile.
--
-- Additive only: twenty-six nullable columns on ApplicationProfile. No table is
-- rebuilt, no column is dropped or retyped, and no existing row is rewritten,
-- so the single "default" profile row keeps every value it already has.
--
-- `fullName`, `school` and `website` are deliberately left in place with their
-- current meanings. The new split-name, education and preference columns exist
-- because an application form asks for them individually: "Legal first name"
-- cannot be answered by splitting a display name on whitespace, and "Degree
-- type" cannot be answered from a ResumeFact sentence that happens to mention
-- a degree. Every new column starts NULL, which the agent reads as "the user
-- has not told us" and therefore refuses to answer rather than guessing.
--
-- No password column is added here or anywhere else in this database.
ALTER TABLE "ApplicationProfile" ADD COLUMN "legalFirstName" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "legalMiddleName" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "legalLastName" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "pronouns" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "alternateEmail" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "phoneCountryCode" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "portfolio" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "degreeType" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "educationLevel" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "major" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "minor" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "educationStartDate" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "graduationDate" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "gpa" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "gpaScale" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "relevantCoursework" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "remotePreference" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "earliestStartDate" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "hasDriversLicense" BOOLEAN;
ALTER TABLE "ApplicationProfile" ADD COLUMN "meetsMinimumAge" BOOLEAN;
ALTER TABLE "ApplicationProfile" ADD COLUMN "referralSource" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "applicationEmail" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "preferredUsername" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "wantsAccountCreationHelp" BOOLEAN;
