-- The rest of the canonical application profile.
--
-- Strictly additive: every statement is ADD COLUMN or CREATE TABLE. No column
-- is dropped, renamed, retyped, or made NOT NULL, and no row of any existing
-- table is read or rewritten. Jobs, match results, generated documents,
-- application runs and résumé facts are untouched.
--
-- Every added column is nullable with no default, which is the point. Null
-- means "the user has not told us", and the agent must treat that as
-- unanswerable rather than as a value. A default here would silently become a
-- fabricated answer on an employer's form.

-- Address line 2 did not exist, which is why the agent had nothing to put in an
-- employer's second address box and copied line 1 into it.
ALTER TABLE "ApplicationProfile" ADD COLUMN "addressLine2" TEXT;

-- A form that asks for a legal middle name and a form that asks the applicant
-- to confirm they have none are different questions. A null middle name cannot
-- answer the second one; this flag can.
ALTER TABLE "ApplicationProfile" ADD COLUMN "noMiddleName" BOOLEAN;
ALTER TABLE "ApplicationProfile" ADD COLUMN "suffix" TEXT;

-- Taleo and iCIMS ask for the nearest metropolitan area, which is often not the
-- city the applicant lives in.
ALTER TABLE "ApplicationProfile" ADD COLUMN "metroRegion" TEXT;

-- Which link to use when a form offers exactly one "Website" box and the
-- profile holds several. Chosen by the user, never picked by precedence.
ALTER TABLE "ApplicationProfile" ADD COLUMN "preferredWebsiteField" TEXT;

-- "Degree you are pursuing" and "highest degree awarded" are different
-- questions and an undergraduate answers them differently. degreeType already
-- holds the first.
ALTER TABLE "ApplicationProfile" ADD COLUMN "highestDegreeAwarded" TEXT;

-- Salary: a strategy plus an optional figure, so "Negotiable" and "$25/hr" are
-- both expressible without one being encoded as free text of the other.
ALTER TABLE "ApplicationProfile" ADD COLUMN "salaryStrategy" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "salaryMinimum" TEXT;

-- Marketing texts are opt-in and never assumed. Null stays unanswered.
ALTER TABLE "ApplicationProfile" ADD COLUMN "marketingTextConsent" BOOLEAN;

-- prefer_guest | create_when_required | always_ask
ALTER TABLE "ApplicationProfile" ADD COLUMN "employerPortalStrategy" TEXT;

-- clearanceEligible is a boolean; a form usually wants the status in words.
ALTER TABLE "ApplicationProfile" ADD COLUMN "securityClearanceStatus" TEXT;

-- What the applicant knows about one employer.
--
-- Kept per company rather than as global booleans because every one of these is
-- a fact about a relationship, and answering "have you worked here before" from
-- a profile-wide default would be a fabrication. A company with no row here has
-- told us nothing, and the agent must ask.
CREATE TABLE "CompanyRelationshipFact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  /** Normalized company name, lower-cased and whitespace-collapsed. */
  "companyKey" TEXT NOT NULL,
  /** As the user typed it, for display. */
  "companyName" TEXT NOT NULL,
  "previouslyEmployed" BOOLEAN,
  "previouslyInterviewed" BOOLEAN,
  "previouslyApplied" BOOLEAN,
  "familyMemberEmployed" BOOLEAN,
  "hasReferral" BOOLEAN,
  "referralName" TEXT,
  "referralEmail" TEXT,
  "referralRelationship" TEXT,
  /** JSON object of company-specific answer overrides, keyed by question. */
  "overrides" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "CompanyRelationshipFact_companyKey_key" ON "CompanyRelationshipFact"("companyKey");
