-- Separate resume tailoring from autofill eligibility: record the document
-- strategy chosen for each ApplicationRun. Additive and non-destructive.
ALTER TABLE "ApplicationRun" ADD COLUMN "documentStrategy" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "documentStrategyReason" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "jobDescriptionCompleteness" TEXT;
