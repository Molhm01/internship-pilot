ALTER TABLE "Job" ADD COLUMN "officialApplyUrl" TEXT;

UPDATE "Job"
SET "officialApplyUrl" = "url"
WHERE "officialApplyUrl" IS NULL
  AND "url" LIKE 'https://%';

ALTER TABLE "ApplicationRun" ADD COLUMN "stageHistory" TEXT;

UPDATE "ApplicationRun"
SET "stageHistory" = json_array(
  json_object(
    'stage', CASE
      WHEN "status" = 'queued' THEN 'QUEUED'
      WHEN "status" = 'running' THEN 'VALIDATING_RUN'
      WHEN "status" = 'needs_user_action' THEN 'NEEDS_USER_ACTION'
      WHEN "status" = 'filled' THEN 'FINAL_REVIEW'
      WHEN "status" = 'failed' THEN 'FAILED'
      ELSE upper("status")
    END,
    'at', strftime('%Y-%m-%dT%H:%M:%fZ', "updatedAt"),
    'detail', coalesce("currentStep", 'Legacy run normalized during migration')
  )
)
WHERE "stageHistory" IS NULL;

UPDATE "ApplicationRun" SET "currentStep" = 'QUEUED' WHERE "status" = 'queued';
UPDATE "ApplicationRun" SET "currentStep" = 'VALIDATING_RUN' WHERE "status" = 'running';
UPDATE "ApplicationRun" SET "currentStep" = 'NEEDS_USER_ACTION' WHERE "status" = 'needs_user_action';
UPDATE "ApplicationRun" SET "currentStep" = 'FINAL_REVIEW' WHERE "status" = 'filled';
UPDATE "ApplicationRun" SET "currentStep" = 'FAILED' WHERE "status" = 'failed';
