-- AlterTable
ALTER TABLE "ApplicationProfile" ADD COLUMN "countryOfResidence" TEXT;

-- AlterTable
ALTER TABLE "ApplicationRun" ADD COLUMN "stoppedFieldContext" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "stoppedFieldOptions" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "stoppedFieldStep" INTEGER;
ALTER TABLE "ApplicationRun" ADD COLUMN "stoppedFieldType" TEXT;
