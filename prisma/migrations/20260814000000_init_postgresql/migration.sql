-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ResumeFact" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'ai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResumeFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeDocument" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'resume',
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "extractedText" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResumeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResumeBullet" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "factIds" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResumeBullet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "storagePath" TEXT NOT NULL,
    "typstSourcePath" TEXT,
    "qaStatus" TEXT NOT NULL,
    "qaIssues" TEXT,
    "keywordClassification" TEXT,
    "tailoringStatus" TEXT,
    "tailoringAudit" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "bulletIdsUsed" TEXT,
    "matchResultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationProfile" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "fullName" TEXT,
    "legalFirstName" TEXT,
    "legalMiddleName" TEXT,
    "noMiddleName" BOOLEAN,
    "legalLastName" TEXT,
    "suffix" TEXT,
    "preferredName" TEXT,
    "pronouns" TEXT,
    "email" TEXT,
    "alternateEmail" TEXT,
    "phone" TEXT,
    "phoneCountryCode" TEXT,
    "linkedin" TEXT,
    "github" TEXT,
    "website" TEXT,
    "portfolio" TEXT,
    "school" TEXT,
    "previousSchool" TEXT,
    "addressStreet" TEXT,
    "addressLine2" TEXT,
    "addressCity" TEXT,
    "addressState" TEXT,
    "addressZip" TEXT,
    "countryOfResidence" TEXT,
    "willingToRelocate" BOOLEAN,
    "locationPreferences" TEXT,
    "internshipTermAvailability" TEXT,
    "salaryAnswerPreference" TEXT,
    "workAuthorization" TEXT,
    "requiresSponsorship" BOOLEAN,
    "clearanceEligible" BOOLEAN,
    "eeoGender" TEXT,
    "eeoRaceEthnicity" TEXT,
    "eeoVeteranStatus" TEXT,
    "eeoDisabilityStatus" TEXT,
    "degreeType" TEXT,
    "educationLevel" TEXT,
    "major" TEXT,
    "minor" TEXT,
    "educationStartDate" TEXT,
    "graduationDate" TEXT,
    "gpa" TEXT,
    "gpaScale" TEXT,
    "relevantCoursework" TEXT,
    "remotePreference" TEXT,
    "earliestStartDate" TEXT,
    "hasDriversLicense" BOOLEAN,
    "meetsMinimumAge" BOOLEAN,
    "referralSource" TEXT,
    "applicationEmail" TEXT,
    "preferredUsername" TEXT,
    "wantsAccountCreationHelp" BOOLEAN,
    "employerPortalStrategy" TEXT,
    "metroRegion" TEXT,
    "preferredWebsiteField" TEXT,
    "highestDegreeAwarded" TEXT,
    "salaryStrategy" TEXT,
    "salaryMinimum" TEXT,
    "marketingTextConsent" BOOLEAN,
    "securityClearanceStatus" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyRelationshipFact" (
    "id" TEXT NOT NULL,
    "companyKey" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "previouslyEmployed" BOOLEAN,
    "previouslyInterviewed" BOOLEAN,
    "previouslyApplied" BOOLEAN,
    "familyMemberEmployed" BOOLEAN,
    "hasReferral" BOOLEAN,
    "referralName" TEXT,
    "referralEmail" TEXT,
    "referralRelationship" TEXT,
    "overrides" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyRelationshipFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "website" TEXT,
    "careersUrl" TEXT,
    "atsType" TEXT,
    "atsIdentifier" TEXT,
    "locations" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'standard',
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "activeInternshipCount" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "monitoringStatus" TEXT NOT NULL DEFAULT 'active',
    "lastCheckStatus" TEXT,
    "lastCheckError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastETag" TEXT,
    "lastModified" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "allowlisted" BOOLEAN NOT NULL DEFAULT true,
    "csvSector" TEXT,
    "csvCareerDomain" TEXT,
    "csvEeCpeFit" TEXT,
    "csvVerificationStatus" TEXT,
    "csvVerificationBasis" TEXT,
    "csvVerifiedDate" TIMESTAMP(3),
    "csvRecommendedSearchTerms" TEXT,
    "csvCanonicalApplyRule" TEXT,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovedAtsTenant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "atsType" TEXT NOT NULL,
    "atsIdentifier" TEXT NOT NULL,
    "discoveredFromCareersUrl" TEXT NOT NULL,
    "evidence" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovedAtsTenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewEmployerReview" (
    "id" TEXT NOT NULL,
    "employerName" TEXT NOT NULL,
    "discoveredFrom" TEXT NOT NULL DEFAULT 'intern-list',
    "guessedCareersUrl" TEXT,
    "guessedDomain" TEXT,
    "sourceJobTitle" TEXT,
    "sourceJobUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "NewEmployerReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityQuarantineEntry" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityQuarantineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovedAnswer" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "questionText" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovedAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "postingDate" TIMESTAMP(3),
    "internshipTerm" TEXT,
    "duration" TEXT,
    "url" TEXT,
    "description" TEXT NOT NULL,
    "jobDescriptionSourceUrl" TEXT,
    "jobDescriptionHash" TEXT,
    "jobDescriptionCapturedAt" TIMESTAMP(3),
    "jobResponsibilities" TEXT,
    "jobQualifications" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT,
    "sourceJobId" TEXT,
    "requisitionId" TEXT,
    "sourceUrl" TEXT,
    "workplaceType" TEXT,
    "firstSeenAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "sourcePostedAt" TIMESTAMP(3),
    "sourcePostedText" TEXT,
    "sourceDateConfidence" TEXT,
    "sourceCapturedAt" TIMESTAMP(3),
    "sourceSyncRunId" TEXT,
    "sourceRowIndex" INTEGER,
    "lastVerifiedAt" TIMESTAMP(3),
    "compensation" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'Unverified',
    "reasonCode" TEXT,
    "verificationReason" TEXT,
    "verificationMethod" TEXT,
    "officialEmployerDomain" TEXT,
    "evidence" TEXT,
    "matchScore" INTEGER,
    "eligibilityStatus" TEXT,
    "discoverySource" TEXT,
    "atsType" TEXT,
    "atsTenant" TEXT,
    "redirectChain" TEXT,
    "httpStatusAtVerification" INTEGER,
    "officialJobUrl" TEXT,
    "officialApplyUrl" TEXT,
    "sourceListingUrl" TEXT,
    "officialApplicationUrl" TEXT,
    "originalJobPostUrl" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'OFFICIAL_URL_UNRESOLVED',
    "resolutionMethod" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionError" TEXT,
    "activeFeed" BOOLEAN NOT NULL DEFAULT false,
    "disciplineTags" TEXT,
    "sophomoreEligible" BOOLEAN,
    "graduationYears" TEXT,
    "sponsorship" TEXT,
    "citizenshipOrClearance" BOOLEAN,
    "compMinHourly" DOUBLE PRECISION,
    "compMaxHourly" DOUBLE PRECISION,
    "season" TEXT,
    "distanceMilesFromClifton" DOUBLE PRECISION,
    "scoringState" TEXT NOT NULL DEFAULT 'NOT_SCORED',
    "scoringPriority" INTEGER NOT NULL DEFAULT 1,
    "scoringError" TEXT,
    "scoringQueuedAt" TIMESTAMP(3),
    "scoringStartedAt" TIMESTAMP(3),
    "scoringFinishedAt" TIMESTAMP(3),
    "scoringHeartbeatAt" TIMESTAMP(3),
    "classification" TEXT,
    "classificationReason" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtsSyncRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "vendors" TEXT NOT NULL,
    "employersChecked" INTEGER NOT NULL DEFAULT 0,
    "employersWithBoard" INTEGER NOT NULL DEFAULT 0,
    "employersFailed" INTEGER NOT NULL DEFAULT 0,
    "rowsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "uniqueRows" INTEGER NOT NULL DEFAULT 0,
    "qualifying" INTEGER NOT NULL DEFAULT 0,
    "notInternship" INTEGER NOT NULL DEFAULT 0,
    "uncertain" INTEGER NOT NULL DEFAULT 0,
    "closed" INTEGER NOT NULL DEFAULT 0,
    "parseFailures" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "duplicatesPrevented" INTEGER NOT NULL DEFAULT 0,
    "persistenceFailures" INTEGER NOT NULL DEFAULT 0,
    "officialUrlsConfirmed" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "failureSummary" TEXT,

    CONSTRAINT "AtsSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchResult" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "eligibility" TEXT NOT NULL,
    "eligibilityReason" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL DEFAULT 'Consider',
    "skillsSupported" TEXT NOT NULL,
    "skillsNeedConfirmation" TEXT NOT NULL,
    "skillsToLearn" TEXT NOT NULL,
    "skillsNeverAdd" TEXT NOT NULL,
    "tailoringPreview" TEXT,
    "factsUsed" TEXT NOT NULL,
    "origin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitialAiMatchJob" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "matchType" TEXT NOT NULL DEFAULT 'INITIAL',
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "matchResultId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InitialAiMatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "newJobsCount" INTEGER NOT NULL DEFAULT 0,
    "updatedJobsCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filterJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ApplicationRun" (
    "id" TEXT NOT NULL,
    "activeKey" TEXT,
    "jobId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "atsType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "currentStep" TEXT,
    "stageHistory" TEXT,
    "needsUserActionReason" TEXT,
    "stoppedFieldLabel" TEXT,
    "stoppedFieldType" TEXT,
    "stoppedFieldOptions" TEXT,
    "stoppedFieldStep" INTEGER,
    "stoppedFieldContext" TEXT,
    "resumeDocumentId" TEXT,
    "coverLetterDocumentId" TEXT,
    "documentStrategy" TEXT,
    "documentStrategyReason" TEXT,
    "jobDescriptionCompleteness" TEXT,
    "matchScoreAtRun" INTEGER,
    "answers" TEXT,
    "confirmationNumber" TEXT,
    "confirmationUrl" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "attemptHistory" TEXT,
    "errorCode" TEXT,
    "validationPath" TEXT,
    "protocolVersion" INTEGER,
    "schemaVersion" INTEGER,
    "tabRemainsOpen" BOOLEAN NOT NULL DEFAULT true,
    "screenshotPath" TEXT,
    "browserLogPath" TEXT,
    "errorLog" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GmailAccount" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "emailAddress" TEXT NOT NULL,
    "encryptedRefreshToken" TEXT NOT NULL,
    "encryptedAccessToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncHistoryId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedEmail" (
    "id" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "classification" TEXT NOT NULL,
    "matchedJobId" TEXT,
    "matchMethod" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssessmentInboxEntry" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "sourceEmailId" TEXT,
    "company" TEXT NOT NULL,
    "jobTitle" TEXT,
    "provider" TEXT,
    "deadline" TIMESTAMP(3),
    "duration" TEXT,
    "link" TEXT,
    "instructions" TEXT,
    "legitimacyNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentInboxEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NearbyFirm" (
    "id" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "distanceMiles" DOUBLE PRECISION,
    "website" TEXT,
    "careersUrl" TEXT,
    "atsType" TEXT,
    "atsIdentifier" TEXT,
    "companyId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'discovered',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),

    CONSTRAINT "NearbyFirm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "employer" TEXT NOT NULL,
    "title" TEXT,
    "location" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "currentlyEmployed" BOOLEAN NOT NULL DEFAULT false,
    "responsibilities" TEXT,
    "approvedBullets" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "startDate" TEXT,
    "endDate" TEXT,
    "technologies" TEXT,
    "description" TEXT,
    "approvedSkills" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationPreferences" (
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensitiveAnswerPreferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gender" TEXT,
    "raceEthnicity" TEXT,
    "veteranStatus" TEXT,
    "disabilityStatus" TEXT,
    "pronouns" TEXT,
    "declineDemographics" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SensitiveAnswerPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeneratedDocument_jobId_idx" ON "GeneratedDocument"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyRelationshipFact_companyKey_key" ON "CompanyRelationshipFact"("companyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Company_atsType_idx" ON "Company"("atsType");

-- CreateIndex
CREATE INDEX "Company_nextCheckAt_idx" ON "Company"("nextCheckAt");

-- CreateIndex
CREATE INDEX "Company_priority_idx" ON "Company"("priority");

-- CreateIndex
CREATE INDEX "Company_allowlisted_idx" ON "Company"("allowlisted");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedAtsTenant_companyId_atsType_atsIdentifier_key" ON "ApprovedAtsTenant"("companyId", "atsType", "atsIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "NewEmployerReview_employerName_key" ON "NewEmployerReview"("employerName");

-- CreateIndex
CREATE INDEX "SecurityQuarantineEntry_jobId_idx" ON "SecurityQuarantineEntry"("jobId");

-- CreateIndex
CREATE INDEX "ApprovedAnswer_userId_idx" ON "ApprovedAnswer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedAnswer_userId_questionText_key" ON "ApprovedAnswer"("userId", "questionText");

-- CreateIndex
CREATE INDEX "Job_source_sourceJobId_idx" ON "Job"("source", "sourceJobId");

-- CreateIndex
CREATE INDEX "Job_sourcePostedAt_idx" ON "Job"("sourcePostedAt");

-- CreateIndex
CREATE INDEX "Job_sourceSyncRunId_sourceRowIndex_idx" ON "Job"("sourceSyncRunId", "sourceRowIndex");

-- CreateIndex
CREATE INDEX "Job_verificationStatus_idx" ON "Job"("verificationStatus");

-- CreateIndex
CREATE INDEX "Job_activeFeed_idx" ON "Job"("activeFeed");

-- CreateIndex
CREATE INDEX "Job_scoringState_idx" ON "Job"("scoringState");

-- CreateIndex
CREATE INDEX "Job_classification_idx" ON "Job"("classification");

-- CreateIndex
CREATE INDEX "AtsSyncRun_startedAt_idx" ON "AtsSyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "VerificationAttempt_jobId_idx" ON "VerificationAttempt"("jobId");

-- CreateIndex
CREATE INDEX "VerificationAttempt_attemptedAt_idx" ON "VerificationAttempt"("attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InitialAiMatchJob_matchResultId_key" ON "InitialAiMatchJob"("matchResultId");

-- CreateIndex
CREATE INDEX "InitialAiMatchJob_state_nextAttemptAt_idx" ON "InitialAiMatchJob"("state", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "InitialAiMatchJob_jobId_matchType_key" ON "InitialAiMatchJob"("jobId", "matchType");

-- CreateIndex
CREATE UNIQUE INDEX "SavedFilter_name_key" ON "SavedFilter"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationRun_activeKey_key" ON "ApplicationRun"("activeKey");

-- CreateIndex
CREATE INDEX "ApplicationRun_jobId_idx" ON "ApplicationRun"("jobId");

-- CreateIndex
CREATE INDEX "ApplicationRun_status_idx" ON "ApplicationRun"("status");

-- CreateIndex
CREATE INDEX "AuditLogEntry_jobId_idx" ON "AuditLogEntry"("jobId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_createdAt_idx" ON "AuditLogEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedEmail_gmailMessageId_key" ON "TrackedEmail"("gmailMessageId");

-- CreateIndex
CREATE INDEX "TrackedEmail_classification_idx" ON "TrackedEmail"("classification");

-- CreateIndex
CREATE INDEX "TrackedEmail_matchedJobId_idx" ON "TrackedEmail"("matchedJobId");

-- CreateIndex
CREATE INDEX "AssessmentInboxEntry_jobId_idx" ON "AssessmentInboxEntry"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "NearbyFirm_placeId_key" ON "NearbyFirm"("placeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE INDEX "Education_userId_idx" ON "Education"("userId");

-- CreateIndex
CREATE INDEX "Experience_userId_idx" ON "Experience"("userId");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationPreferences_userId_key" ON "ApplicationPreferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SensitiveAnswerPreferences_userId_key" ON "SensitiveAnswerPreferences"("userId");

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedAtsTenant" ADD CONSTRAINT "ApprovedAtsTenant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedAnswer" ADD CONSTRAINT "ApprovedAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationAttempt" ADD CONSTRAINT "VerificationAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitialAiMatchJob" ADD CONSTRAINT "InitialAiMatchJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InitialAiMatchJob" ADD CONSTRAINT "InitialAiMatchJob_matchResultId_fkey" FOREIGN KEY ("matchResultId") REFERENCES "MatchResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationRun" ADD CONSTRAINT "ApplicationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationPreferences" ADD CONSTRAINT "ApplicationPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensitiveAnswerPreferences" ADD CONSTRAINT "SensitiveAnswerPreferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

