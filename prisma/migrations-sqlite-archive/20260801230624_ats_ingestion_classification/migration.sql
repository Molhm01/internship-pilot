-- Additive migration only. No table is rebuilt and no row is rewritten, so
-- every existing Job (including all legacy Intern List records), MatchResult,
-- and GeneratedDocument is preserved byte-for-byte.
--
-- Prisma's generated version wanted to DROP and recreate "Job" to reconcile
-- unrelated default drift on other tables. That was replaced by hand with the
-- two ALTER TABLE statements below, which are the only real schema deltas.

-- Canonical internship classification. NULL on pre-existing rows, which the
-- application treats as "not yet classified" — never as a rejection.
ALTER TABLE "Job" ADD COLUMN "classification" TEXT;
ALTER TABLE "Job" ADD COLUMN "classificationReason" TEXT;

CREATE INDEX "Job_classification_idx" ON "Job"("classification");

-- Per-run ingestion metrics.
CREATE TABLE "AtsSyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
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
    "failureSummary" TEXT
);

CREATE INDEX "AtsSyncRun_startedAt_idx" ON "AtsSyncRun"("startedAt");
