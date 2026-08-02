-- AlterTable
ALTER TABLE "ApplicationProfile" ADD COLUMN "clearanceEligible" BOOLEAN;
ALTER TABLE "ApplicationProfile" ADD COLUMN "eeoDisabilityStatus" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "eeoGender" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "eeoRaceEthnicity" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "eeoVeteranStatus" TEXT;
ALTER TABLE "ApplicationProfile" ADD COLUMN "requiresSponsorship" BOOLEAN;
ALTER TABLE "ApplicationProfile" ADD COLUMN "workAuthorization" TEXT;
