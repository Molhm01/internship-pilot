UPDATE "Job"
SET "sourceListingUrl" = "sourceUrl"
WHERE "sourceListingUrl" IS NULL
  AND "sourceUrl" IS NOT NULL;
