-- AlterTable
ALTER TABLE "Job" ADD COLUMN "evidence" TEXT;
ALTER TABLE "Job" ADD COLUMN "officialEmployerDomain" TEXT;
ALTER TABLE "Job" ADD COLUMN "verificationMethod" TEXT;

-- Data migration (non-destructive): rename the old "Verified" status value to
-- the new, stricter "VERIFIED_OFFICIAL" vocabulary introduced in Milestone 3.
-- No rows are deleted.
UPDATE "Job" SET "verificationStatus" = 'VERIFIED_OFFICIAL' WHERE "verificationStatus" = 'Verified';

UPDATE "Job" SET "verificationMethod" = 'manual-entry'
WHERE "verificationStatus" = 'VERIFIED_OFFICIAL' AND "source" IS NULL AND "verificationMethod" IS NULL;

UPDATE "Job" SET "verificationMethod" = 'legacy-verified'
WHERE "verificationStatus" = 'VERIFIED_OFFICIAL' AND "verificationMethod" IS NULL;
