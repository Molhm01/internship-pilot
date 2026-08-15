-- AlterTable
ALTER TABLE "ApplicationRun" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ApplicationRun" ADD COLUMN "attemptHistory" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "validationPath" TEXT;
ALTER TABLE "ApplicationRun" ADD COLUMN "protocolVersion" INTEGER;
ALTER TABLE "ApplicationRun" ADD COLUMN "schemaVersion" INTEGER;
ALTER TABLE "ApplicationRun" ADD COLUMN "tabRemainsOpen" BOOLEAN NOT NULL DEFAULT true;
