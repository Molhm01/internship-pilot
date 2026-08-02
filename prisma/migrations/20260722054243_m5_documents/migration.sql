-- CreateTable
CREATE TABLE "ResumeBullet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "factIds" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "storagePath" TEXT NOT NULL,
    "typstSourcePath" TEXT,
    "qaStatus" TEXT NOT NULL,
    "qaIssues" TEXT,
    "keywordClassification" TEXT,
    "bulletIdsUsed" TEXT,
    "matchResultId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneratedDocument_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApplicationProfile" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "fullName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "linkedin" TEXT,
    "github" TEXT,
    "website" TEXT,
    "school" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ResumeDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'resume',
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "extractedText" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ResumeDocument" ("createdAt", "extractedText", "filename", "id", "pageCount", "sizeBytes", "status", "storagePath") SELECT "createdAt", "extractedText", "filename", "id", "pageCount", "sizeBytes", "status", "storagePath" FROM "ResumeDocument";
DROP TABLE "ResumeDocument";
ALTER TABLE "new_ResumeDocument" RENAME TO "ResumeDocument";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "GeneratedDocument_jobId_idx" ON "GeneratedDocument"("jobId");
