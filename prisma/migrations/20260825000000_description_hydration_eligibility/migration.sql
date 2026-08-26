-- Description-hydration eligibility (database-usage repair, pass #4).
--
-- hydrateMissingDescriptionsForScoring used to read every activeFeed job and
-- filter in application code for "missing a usable description or a source-
-- posted date" — a full-table scan on every hourly-to-bi-hourly run. This
-- column lets that query become a bounded, indexed WHERE clause instead.
--
-- NOT DESTRUCTIVE: purely additive (one nullable column, one index). Every
-- existing row defaults to NULL, which the application code treats as
-- "never evaluated, eligible now" — the same jobs that were eligible before
-- this migration remain eligible immediately after it, so there is no
-- backfill step and no window where a job that needs hydration is silently
-- skipped.
--
-- DO NOT APPLY to the production database as part of this change. This file
-- is prepared source control only — see the DATABASE EFFICIENCY PASS #4
-- report for why (the production Prisma Postgres database was suspended for
-- the Free-plan operations overage this whole repair effort addresses, and
-- this session was instructed not to access or restore it). Apply this with
-- `npx prisma migrate deploy` against production only when you are ready,
-- BEFORE deploying the application code that queries this column — the code
-- in src/lib/matching/jobDescriptionHydration.ts as of this commit already
-- queries `descriptionHydrationNextAttemptAt` and will fail against a
-- database that does not yet have this column.
ALTER TABLE "Job"
  ADD COLUMN "descriptionHydrationNextAttemptAt" TIMESTAMP(3);

CREATE INDEX "Job_activeFeed_descriptionHydrationNextAttemptAt_idx"
  ON "Job"("activeFeed", "descriptionHydrationNextAttemptAt");
