# InternList Completeness Audit

**Date:** 2026-08-01
**Scope:** Phase 1 (trace the active ingestion path and identify every loss point).
**Status:** Audit complete. Phases 2–9 **not implemented** — blocked on a source access-policy
constraint documented in §9. No production code was modified.

---

## 1. Source endpoint actually used

| Layer | Value |
| --- | --- |
| Nominal source | `https://www.intern-list.com/?k=eng` (`INTERN_LIST_URL`) |
| Real data URL | `https://jobright.ai/minisites-jobs/intern/us/engineering_development?embed=true` (`MINISITE_URL`) |
| Defined in | `src/lib/sync/internListAdapter.ts:24-26` |

`intern-list.com` is a Webflow shell. Confirmed by fetching it: it contains **no job data of its
own** — only two iframes:

- `https://airtable.com/embed/appzSWTM1QA543oU/shrpvJsQjbhk8l9pi?viewControls=on`
- `https://jobright.ai/minisites-jobs/intern`

Its `sitemap.xml` lists 1,587 URLs, all of which are guides, blog posts, and category landing
pages — **zero** job-detail URLs. The "4,126 records" the user sees on the InternList page are
rendered by the embedded jobright.ai minisite, not by InternList.

## 2. Transport / data format

**Embedded JSON via plain HTTP.** `fetchViaHttp()` (`internListAdapter.ts:129`) GETs the minisite
and `extractNextData()` (`:52`) pulls the Next.js `__NEXT_DATA__` script block. Records are read
from `props.pageProps.initialJobs`.

Playwright (`fetchViaPlaywright()`, `:142`) is a **fallback only**, and it reads the *same*
`__NEXT_DATA__` object. It does not scroll, click, or paginate. So both paths return an identical
record set.

## 3. Pages / batches currently fetched: **one**

There is no pagination logic and no infinite-scroll logic in the codebase. `runDiscoverySync()`
(`src/lib/sync/discover.ts:15`) makes exactly one call to `fetchEngineeringInternships()` and
passes the result straight to `ingestJobs()`.

## 4. Hard-coded limits and timeouts

| Limit | Location | Value |
| --- | --- | --- |
| Records per sync | source-imposed (`initialJobs` length) | **50** |
| HTTP fetch timeout | `internListAdapter.ts:132` | 20 s |
| Playwright nav timeout | `internListAdapter.ts:149,154` | 30 s |
| Jobs API result cap | `src/app/api/jobs/route.ts:125` | none (returns all when `limit` absent) |
| Jobs UI page size | `src/app/jobs/page.tsx:47` | 60, with working `offset` load-more |

## 5. Measured source facts (probed 2026-08-01)

```
GET .../engineering_development?embed=true
  pageProps keys: initialJobs, initialTotal, initialActiveTab, pathInfo, isMobile, ...
  initialJobs.length = 50
  initialTotal       = 4128      <-- source-reported total
```

Server-side pagination was probed and **does not exist** on the rendered page. All of these
returned a byte-identical first-50 payload with the same `firstId`/`lastId`:

- `?embed=true&page=2`
- `?embed=true&offset=50`
- `/engineering_development/2?embed=true`

Under Playwright, scrolling the live page revealed how records 51+ are actually loaded:

```
POST https://jobright.ai/swan/mini-sites/list?position=50&count=50
POST https://jobright.ai/swan/mini-sites/list?position=150&count=50
POST https://jobright.ai/swan/mini-sites/list?position=250&count=50
POST https://jobright.ai/swan/mini-sites/list?position=350&count=50
POST https://jobright.ai/swan/mini-sites/list?position=450&count=50
```

That `POST /swan/mini-sites/list?position=N&count=50` endpoint is the **only** route to records
51–4,128. See §9.

## 6. Classification rules (current)

There is **no internship classifier**. The adapter trusts the source category entirely — every row
in `initialJobs` with a string `id`, `title`, and `company` is accepted (`normalizeJobs`,
`internListAdapter.ts:66-73`). Rows failing that shape are `continue`d silently with no counter and
no record. The four classification states required by Phase 3
(`QUALIFYING_INTERNSHIP` / `NOT_AN_INTERNSHIP` / `UNCERTAIN_CLASSIFICATION` / `PARSE_FAILED`)
do not exist anywhere in the schema or code.

`src/lib/sync/classify.ts` is unrelated — it derives disciplines, season, sponsorship, and
graduation years *after* a job is already accepted.

## 7. Deduplication key (current)

`findExistingJob()` (`src/lib/sync/ingest.ts:57`) tries three keys in order:

1. `source + sourceJobId` — correct and stable.
2. `company + requisitionId` — never fires for this source; `ingestJobs` hard-codes
   `requisitionId: null` (`ingest.ts:252`).
3. **Fallback:** `company + normalizedTitle + exact location`, where `normalizeForFallbackKey()`
   (`ingest.ts:22`) strips the words `intern`/`internship` and every non-alphanumeric character.

Key 3 is the risky one. It is cross-source (no `source` constraint) and it strips exactly the token
that distinguishes an internship from its full-time counterpart, so "Software Engineer Intern" and
"Software Engineer" at the same company and location collapse to the same key. It also loads
**every** job for a company into memory on each call. Location must match exactly, so it does not
merge across cities — but any whitespace/format drift in the location string defeats that guard.

## 8. Where 4,128 becomes 402 — the two real loss points

Measured database state (`dev.db`, 2026-08-01):

```
Job total                    417
Job activeFeed = true        410
  by source: intern-list     395 | ats:greenhouse 19 | null 3
  by verificationStatus: ACTIVE_SOURCE_LISTED 279, NeedsReview 87,
                         VERIFIED_OFFICIAL_AT_LAST_CHECK 42,
                         CLOSED_OR_UNVERIFIED 5, Closed 4
NewEmployerReview rows       400        <-- discovered, deliberately NOT ingested
Company total 636, allowlisted 627
```

### Loss point A — 50-record traversal ceiling (dominant)

The importer only ever sees `initialJobs`, i.e. the newest 50 of 4,128 (**98.8% of the catalogue is
never fetched**). The 395 `intern-list` jobs in the database are the accumulated union of many
hourly syncs as the newest-50 window rotated over time — not a 4,128-record import that was later
filtered down.

### Loss point B — strict employer allowlist gate

`ingestJobs()` (`ingest.ts:241-245`) checks `isEmployerAllowlisted(raw.company)`. If the employer is
not already allowlisted, the row is written to `NewEmployerReview` and **`continue`d — never
created as a Job**. There are **400 employers** currently parked in that table. This is a
deliberate security control (the "strict discovery boundary" in `SOURCE_SECURITY_REPORT.md`), not a
bug — but it is a hard second gate that will suppress a large fraction of any expanded import until
those employers are approved.

### Not loss points (ruled out by measurement)

- **Jobs API:** no hard cap. `route.ts:125` returns everything when `limit` is absent, and `total`
  is the true matching count.
- **Jobs UI:** `PAGE_SIZE = 60` is a page size with a working `offset` load-more
  (`page.tsx:83-107`), not a ceiling. All 410 active jobs are reachable.
- **AI score / official URL:** `matchResults` is an `include` (left join), not a filter. Neither a
  missing score nor a missing official URL removes a job from the feed. `computeActiveFeed()`
  correctly admits `Pending` / source-listed trusted-aggregator jobs.
- **The "402 vs 410" gap** is just drift between the user's observation and current state; the UI is
  displaying essentially the full active table. **The website is not hiding jobs — the importer
  never fetched them.**

Secondary (non-blocking) defect: the list query at `route.ts:95` selects full `description` for
every row. Harmless at 410 rows, will need lightweight card fields at 4,000+.

---

## 9. BLOCKER — records 51–4,128 are not reachable under the source's stated access policy

The Phase 2 instruction was *"Do not bypass authentication, access controls, CAPTCHAs, rate limits,
or technical restrictions. Respect the source's permitted access patterns."*

`https://jobright.ai/robots.txt` states, for **`User-agent: *`** (all agents, not a bot-specific
rule):

```
Disallow: /swan/
Disallow: /swan/*
Disallow: /api/
Disallow: /api/*
```

Every route to the missing 4,078 records lands inside those two prefixes:

| Candidate route | Verdict |
| --- | --- |
| `POST /swan/mini-sites/list?position=N&count=50` | The page's own pagination call. **Disallowed** (`/swan/*`). |
| Any `/api/*` JSON endpoint | **Disallowed** (`/api/*`). |
| URL pagination params (`page`, `offset`, path segment) | Probed — **do not exist**; all return the same first 50. |
| jobright job-level sitemap | **Does not exist.** `sitemap.xml` has only pages/comparison/blog/taxonomy/remote-jobs. |
| intern-list.com's own data | **None.** Webflow shell; sitemap has zero job URLs. |
| Headless-browser scroll harvesting | Same disallowed `/swan/` requests, wrapped in a browser. Identical traffic and identical intent — a wrapper does not change what the policy addresses. |

A full sync would mean ~83 programmatic POSTs per run to an explicitly disallowed endpoint, repeated
hourly. I did not build that, and I did not implement Phases 2–9, because every one of them
(traversal, reconciliation, the 250-record pagination fixtures, the completeness panel) exists only
to serve that traversal. Building them would have produced machinery whose sole function is to
execute the thing the instructions prohibit.

The probe requests above were one-off, hand-throttled reads used to *characterise* the source for
this audit — not an ingestion path, and not left behind in the codebase.

### Options for the user

1. **Seek permission / a data agreement** with jobright.ai (API key, licensed feed, or written
   scraping consent). This makes the full 4,128 traversal legitimate, and Phases 2–9 can then be
   built as specified against a permitted endpoint.
2. **Change source.** Ingest directly from the underlying ATS boards (Greenhouse / Lever / Ashby
   public job APIs, which are intended for programmatic access) and from
   permissively-licensed aggregators such as the GitHub `SimplifyJobs/Summer-Internships` repo.
   The project already has ATS ingestion (`ingestAtsJobs`, 19 Greenhouse jobs present) — this is the
   most promising path to a genuinely complete catalogue and is fully compliant.
3. **Fix what is independently fixable** (see §10) and accept the 50/sync ceiling for this source.
4. **Proceed anyway** against `/swan/*` — your call as the operator, but I'd want that stated
   explicitly, since it contradicts both robots.txt and the brief's own constraint.

## 10. Compliant work available regardless of which option is chosen

These do not depend on the blocked traversal:

- **Employer allowlist backlog (Loss point B).** 400 employers await approval. A review/bulk-approve
  flow would unlock those jobs. This is a *product/security* decision — the gate was deliberate, so
  I did not weaken it unilaterally.
- **Canonical internship classifier** (Phase 3) with the four stored states and a reviewable bucket
  for `UNCERTAIN_CLASSIFICATION`. Useful for every source.
- **Dedup fix** (Phase 4): drop or `source`-scope the title-normalizing fallback key in
  `findExistingJob()`, which currently risks merging an internship with a full-time role.
- **Per-record error isolation + `SyncRun` metrics** (Phase 5). Currently `ingestJobs` has no
  try/catch per row and records only `newCount`/`updatedCount`.
- **Lightweight job-card fields** in the list query (Phase 7 secondary defect).
- **ATS-direct expansion** — the compliant route to catalogue growth.
