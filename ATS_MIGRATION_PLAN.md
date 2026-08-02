# ATS Migration Plan — moving primary ingestion off Intern List / Jobright

**Date:** 2026-08-01
**Decision:** Option 2 from `INTERNLIST_COMPLETENESS_AUDIT.md`. Jobright's catalogue is only
reachable through `POST /swan/mini-sites/list`, which its robots.txt disallows for all agents. Rather
than bypass that, primary discovery moves to sources that *intend* programmatic access.

This is a **migration, not a rewrite.** No existing row is deleted, rewritten, or re-keyed.

---

## 1. What happens to existing data

| Data | Treatment |
| --- | --- |
| 417 existing Jobs (395 `intern-list`) | **Preserved untouched.** Still visible, still applyable. |
| MatchResults / AI scores | **Preserved.** Nothing in this work touches scoring. |
| GeneratedDocuments | **Preserved.** Untouched. |
| ApplicationRuns / sessions / queues | **Untouched.** Out of scope by instruction. |
| Companies (636) | Preserved; `atsType`/`atsIdentifier` enriched in place. |
| NewEmployerReview (400) | Preserved; 38 approved-but-orphaned rows given their missing Company. |

`intern-list` and `jobright` records become **legacy/source-only**: they remain in the active feed
and keep their provenance, but no new records arrive from them. `runDiscoverySync()` is left intact
and functional — it is simply no longer the growth path. Nothing was ripped out, so there is no
flag-day and no rollback cliff.

### Schema changes (additive only)

Migration `20260801230624_ats_ingestion_classification`:

```sql
ALTER TABLE "Job" ADD COLUMN "classification" TEXT;
ALTER TABLE "Job" ADD COLUMN "classificationReason" TEXT;
CREATE INDEX "Job_classification_idx" ON "Job"("classification");
CREATE TABLE "AtsSyncRun" (...);
```

Prisma's generated migration wanted to DROP and recreate `Job` to reconcile unrelated default drift
on other tables. That was **replaced by hand** with the two `ALTER TABLE` statements above, so no
table is rebuilt and no row is rewritten. A timestamped backup (`dev.db.bak-pre-ats-*`) was taken
before applying.

`classification` is NULL on all pre-existing rows. Null is treated as *"not yet classified"* and
**never** as a rejection — that is what keeps legacy Intern List jobs visible.

## 2. Source priority

1. **Greenhouse / Lever / Ashby** public board APIs — implemented in this phase.
2. SmartRecruiters public postings — adapter already exists, not yet wired to resolution.
3. Workday tenants where technically supported — adapter exists.
4. Verified employer career sites — existing generic scan, lowest trust.
5. Existing engineering-company database (636 rows) — the seed list driving all of the above.

Greenhouse, Lever, and Ashby were chosen first because all three publish documented,
unauthenticated board APIs intended for programmatic consumption, and none is disallowed by the
vendors' robots.txt. Their `applyUrl` **is** the employer's official application page, which
satisfies the "every imported job must carry a direct official URL" requirement by construction
rather than by a later verification pass.

## 3. Migration stages

**Stage 1 — repair the employer backlog** (done)
`npm run employers:repair -- --apply` created the 38 missing Company rows for employers already
approved. 3 test/demo fixtures were excluded via the existing `DEMO_OR_FIXTURE_COMPANY` policy.
The 211 still-pending reviews are **reported, not auto-approved** — approving an employer is a trust
decision that belongs to the user.

**Stage 2 — resolve ATS boards** (done)
`npm run ats:resolve -- --apply` probes each allowlisted company's candidate board slugs against the
three vendors and records the hit. Defaults to dry-run.

**Stage 3 — ingest** (repeatable)
`npm run ats:sync -- --apply` pulls every resolved board, classifies each posting, and persists the
qualifying internships. Defaults to dry-run. Idempotent: a second run updates rather than duplicates.

**Stage 4 — widen** (future)
Wire SmartRecruiters and Workday into resolution; revisit unresolved companies with a careers-page
link check.

## 4. Verification-status model

Direct ATS reads are recorded as `VERIFIED_OFFICIAL_AT_LAST_CHECK` with reason code
`OFFICIAL_ATS_BOARD`, because the URL was obtained from the employer's own system. This fixed a
latent bug: `ingestAtsJobs` previously wrote every ATS job as `Pending`, and since ATS sources are
not "trusted aggregators", `computeActiveFeed()` returned **false** — ATS-ingested jobs were
invisible. That is why only 19 Greenhouse jobs existed and none of them surfaced.

Visibility still never depends on an AI score, a tailored document, or a match result.

## 5. Rollback

1. Restore `dev.db.bak-pre-ats-*` (full pre-migration snapshot), **or**
2. Leave the schema (additive, harmless) and delete only the new rows:
   `DELETE FROM "Job" WHERE source IN ('greenhouse','lever','ashby') AND firstSeenAt > '<run start>'`.
   Legacy Intern List records are untouched by either path.

To revert board resolution only, clear `atsIdentifier` / reset `atsType` to `'unknown'` for the
affected companies; job rows are unaffected.

## 6. Defects found and fixed while running the migration

Four real data-loss bugs surfaced only once the pipeline ran against live boards. All four are
covered by regression tests.

**a) `gh_jid` stripped as a tracking parameter (severe).**
`canonicalizeJobUrl` dropped every parameter matching the prefix `gh_`. On employer-hosted
Greenhouse boards the job identity *is* a query parameter — `https://waymo.com/careers/?gh_jid=N` —
so all 393 Waymo postings, 392 AST SpaceMobile, 154 CannonDesign, and others collapsed to a single
URL each. 992 real postings would have been discarded as "duplicates". The blocklist is now
explicit rather than prefix-based: `gh_src` is dropped, `gh_jid` is preserved, and any unrecognized
parameter is kept rather than assumed to be tracking.

**b) Board-identity false matches.**
The first resolution sweep attributed `ashby/jobs` to Abbott, Adient, and American Electric Power
(from careers hostnames like `jobs.abbott.com`), `greenhouse/air` to Air Products, and — worst —
the *same* board `greenhouse/general` to both **General Atomics** and **General Motors**. Fixed by
a generic-slug blocklist, a Jaccard-similarity board-name check, and restricting weak "first word"
slugs to Greenhouse, the only vendor exposing a board name to verify against. The affected
resolutions were cleared and re-derived from scratch.

**c) `gh_jid` URLs rejected as non-job-specific.**
`isEmployerJobUrl` recognized `job`/`req`/`requisition` parameters but not the vendor `*_jid`
family, so Motional, Nuro, and CannonDesign internships were imported with
`OFFICIAL_URL_UNRESOLVED` and no application URL. Added `jid`/`gh_jid`/`lever_jid`/`ashby_jid`.

**d) `http://` board URLs had no usable destination.**
CannonDesign's board advertises `http`, and the destination policy is https-only (correctly — the
application worker navigates these URLs). Rather than weaken that policy, `secureAtsUrl()` upgrades
only the scheme, preserving host and path.

## 7. Known limitation — strict board-identity matching

`boardNameMatchesCompany()` rejects a single-token board name against a multi-token company
("Air" vs "Air Products"), because that pattern produced real false matches during development —
Abbott, Adient, and American Electric Power all resolved to an unrelated Ashby board named `jobs`,
and Air Products to a Greenhouse board named `Air`.

The cost is some genuine one-word boards (e.g. `align` for "Align Technology") are reported
unresolved. This is the safe direction to be wrong in: an unresolved company is *visible* in the
resolver output and can be fixed by setting `Company.atsIdentifier` manually, whereas a false match
would silently import a different company's postings under the wrong employer name.

## 8. Where the growth comes from next

Only **58 of 658** companies have a resolved board, and those 58 alone yielded 9,584 postings and
152 qualifying internships. The 603 unresolved companies are the entire remaining upside, in
priority order:

1. **211 pending `NewEmployerReview` rows** — need your approve/reject decision, then re-resolution.
2. **Wire SmartRecruiters and Workday into `ats-resolve`** — adapters already exist
   (`src/lib/ats/smartrecruiters.ts`, `workday.ts`); they are simply not probed yet.
3. **Manual `atsIdentifier` for known-good boards** rejected by the strict identity rule
   (e.g. `align` for Align Technology). Setting `Company.atsIdentifier` by hand bypasses probing.
4. **Careers-page link discovery** — parse each employer's careers page for a board URL instead of
   guessing slugs. This would resolve most of the remaining 603 and is the highest-leverage next step.
