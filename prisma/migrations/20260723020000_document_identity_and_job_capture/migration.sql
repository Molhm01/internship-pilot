ALTER TABLE "Job" ADD COLUMN "jobDescriptionSourceUrl" TEXT;
ALTER TABLE "Job" ADD COLUMN "jobDescriptionHash" TEXT;
ALTER TABLE "Job" ADD COLUMN "jobDescriptionCapturedAt" DATETIME;
ALTER TABLE "Job" ADD COLUMN "jobResponsibilities" TEXT;
ALTER TABLE "Job" ADD COLUMN "jobQualifications" TEXT;

ALTER TABLE "GeneratedDocument" ADD COLUMN "tailoringStatus" TEXT;
ALTER TABLE "GeneratedDocument" ADD COLUMN "tailoringAudit" TEXT;
ALTER TABLE "GeneratedDocument" ADD COLUMN "identityVerified" BOOLEAN NOT NULL DEFAULT false;
