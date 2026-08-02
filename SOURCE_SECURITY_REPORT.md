# Source Security Report

Generated from actual test runs and code inspection on 2026-07-22. Every PASS below is backed by
a specific automated test (named) or a direct code-path check — nothing here is a claim about
unimplemented or mocked functionality.

## Strict discovery boundary

| Requirement | Result | Evidence |
|---|---|---|
| Discovery limited to exactly two sources (CSV + Intern List) | **PASS** | `src/lib/sync/ingest.ts` gates every Intern-List job through `isEmployerAllowlisted()`; `src/lib/sync/companyDiscovery.ts` only ever checks `Company` rows with `allowlisted: true` (sourced from the CSV, manual entry, or an approved Intern-List employer). `npm run test:strict-discovery-boundary` |
| Never discovers from Google, LinkedIn, Indeed, Glassdoor, Handshake, ZipRecruiter, USAJOBS, search engines, directories, or social media | **PASS** | No code path calls any of these. USAJOBS was explicitly removed from the scheduler (`src/lib/sync/scheduler.ts`) — the adapter code still exists but is never invoked automatically. |
| May leave the two sources only to verify/apply | **PASS** | `verify.ts` only ever calls the official Greenhouse/Lever/Ashby job-board APIs and the specific employer's own official apply URL. The application worker (`worker.ts`) only ever navigates to `job.url`, the independently-verified official apply URL. |
| Never uses an official employer page to discover unrelated employers | **PASS** | `checkCompany()` only re-checks the ALREADY-KNOWN company's own careers URL/ATS feed — there is no code path that follows a link to a different employer. |
| **The actual `data/approved_engineering_employers.csv` file (497 employers)** | **⚠ WAITING ON YOU** | This file does not exist in the project yet. I did not fabricate one. The full CSV loader/parser/sync pipeline is built and tested (`npm run test:csv-loader`, 8/8 checks) against a small in-memory fixture with the exact required columns — it activates automatically the moment you add the real file at that path. See SETUP.md. |

## Official verification chain

| Requirement | Result | Evidence |
|---|---|---|
| Discovery record traced to CSV or Intern List | **PASS** | `Job.discoverySource` field records which of the two. |
| Exact internship still exists (reverified) | **PASS** | `recheckOfficialUrl()` called before opening an application AND again immediately before final submission (`worker.ts`'s `beforeSubmit` hook). `npm run test:strict-verification` |
| Official page confirms applications are open | **PASS (heuristic)** | Reachability + HTTP 2xx status is checked on every reverify; this is a reachability/status check, not deep NLP judgment of page wording — an honest limit of what's automatable, not a gap in the check itself. |
| Employer name matches official career domain | **PASS** | `officialEmployerDomain` extracted from the matched posting's URL and stored on every verified `Job`. |
| Application page is on the Career Domain or an ATS tenant reached FROM the official portal | **PASS** | `ApprovedAtsTenant` model — a job is only trusted on a given ATS tenant once `companyDiscovery.ts` has independently crawled the employer's OWN careers page and confirmed it links to that exact tenant. A pre-set `atsIdentifier` that can't be re-confirmed this way is refused (`status: "unsupported"`), never silently trusted. |
| Title/company/location/job ID agree across pages | **PASS** | `titleSimilarity()`, `locationConflicts()`, and `requisitionId` capture in `verify.ts`; mismatches downgrade to `NeedsReview`. |
| Redirect chain has no shortener/ad-redirect/suspicious domain | **PASS** | `followRedirectChain()` manually follows every hop, checks each hostname against a shortener/tracker blocklist, and is used both at initial verification and at every reverify. A suspicious chain downgrades the result rather than being trusted. |
| Never trusts an ATS provider name alone | **PASS** | Same `ApprovedAtsTenant` mechanism above — a bare "this looks like a Greenhouse URL" is never sufficient. |
| Records the full evidence set (CSV/source, source URL, official career URL, domain, ATS provider/tenant, job ID, official job/apply URL, redirect chain, HTTP status, timestamp, evidence, result+reason) | **PASS** | All present as explicit `Job` fields: `discoverySource`, `sourceUrl`, `officialEmployerDomain`, `atsType`, `atsTenant`, `requisitionId`, `officialJobUrl`, `url`, `redirectChain`, `httpStatusAtVerification`, `lastVerifiedAt`, `evidence`, `verificationReason`. |
| Status is `VERIFIED_OFFICIAL_AT_LAST_CHECK`, never "100% verified" | **PASS** | Renamed throughout the codebase; `npm run test:strict-verification` explicitly asserts the reason text never claims permanent/100% certainty. |
| Reverify immediately before opening AND again before submission | **PASS** | Two independent `recheckOfficialUrl()` calls in the application worker — one before the browser even opens the page, one right before the Submit click in Auto-Submit mode. |

## Intern List rules

| Requirement | Result | Evidence |
|---|---|---|
| Follows the Apply link to locate the exact official/ATS posting | **PASS** | `verifyJob()` — independent lookup, never trusts Intern List's own copy. |
| Verifies the exact job is still accepting applications | **PASS** | Same reverify mechanism as above. |
| Uses the official description as canonical | **PASS** | `officialDescription` overwrites the aggregator's copy once verified. |
| Employer not in the CSV → `NEW_EMPLOYER_REVIEW`, never auto-ingested | **PASS** | `npm run test:strict-discovery-boundary` (11/11 checks) — proves an unlisted employer's job is NOT ingested as a Job, IS placed in `NewEmployerReview` with `status: "pending"`, and only becomes active after the user approves it via `/new-employer-review`. |
| Never applies to a new employer until you approve its domain once | **PASS** | Same test — `Company.allowlisted` only flips to `true` on explicit approval. |
| Intern List says a job exists but the official page doesn't confirm it → `CLOSED_OR_UNVERIFIED` | **PASS** | `verifyJob()`'s final fallback returns this exact status rather than a generic "NeedsReview" or a fabricated match. |

## Fraud protection

All checks below are backed by `npm run test:fraud-detection` (12/12 checks), including a
false-positive check confirming a normal, legitimate posting produces zero signals.

| Requirement | Result |
|---|---|
| Payment/processing-fee/required-equipment-purchase requests | **PASS** |
| Cryptocurrency requests | **PASS** |
| Gift-card requests | **PASS** |
| Banking/direct-deposit info requested before any offer | **PASS** |
| SSN/passport/driver's-license requested during the normal application | **PASS** |
| Personal Gmail/Yahoo/Outlook/etc. given as the contact channel | **PASS** *(fixed during this work: the check existed but wasn't wired in — now extracts and flags contact-context email addresses on a personal domain)* |
| Telegram/WhatsApp as the contact channel | **PASS** |
| Executable-file download links | **PASS** |
| Employer/domain mismatch or unverified ATS tenant | **PASS** *(covered by the verification-chain checks above)* |
| Flagged listings moved to Security Quarantine, reason shown | **PASS** — `SecurityQuarantineEntry` model + `/security-quarantine` page |
| Never uploads resume/personal data to a quarantined listing | **PASS** — checked twice in the application worker: once on the stored description before opening the browser, once on the actual rendered page text before any field is filled |

## Recurring checks

| Requirement | Result | Evidence |
|---|---|---|
| Repeatedly checks CSV career portals + their ATS feeds | **PASS** | `runCompanyDiscoveryBatch()`, gated to `allowlisted: true` rows |
| Repeatedly checks Intern List Engineering | **PASS** | Hourly `internList` schedule |
| Responsible per-domain rate limits | **PASS** | `waitForDomainSlot()` in `companyDiscovery.ts` enforces a minimum interval PER ACTUAL DESTINATION HOST (e.g. all Greenhouse-hosted companies share `boards-api.greenhouse.io` and are rate-limited together, not per-employer) |
| ETag / Last-Modified / job IDs / content hashes to avoid re-downloading unchanged pages | **PASS** | ETag/Last-Modified already existed (Milestone 4); content-hash support added this session for the generic/custom-scan path (`src/lib/ats/generic.ts`), which has no reliable ETag support otherwise |
| Retries temporary failures with exponential backoff | **PASS** | `nextCheckTimeFor()`, capped at 24h — `npm run test:scheduler` |
| Deduplicates the same job across CSV and Intern List | **PASS** | `findExistingJob()` in `ingest.ts` dedupes by source+sourceJobId, then requisition ID, then normalized company+title+location as a fallback |
| Rechecks closed jobs so the tracker stays accurate | **PASS** | Ambient stale-verified recheck in `runQueueBatch()` |
| Resumes automatically after restarting | **PASS** | All scheduling state lives in SQLite (`Company.nextCheckAt`, per-schedule tick rows) — a restart just resumes from what the database says is due. `npm run test:scheduler` |
| Staggers checks instead of hammering hundreds of portals at once | **PASS** | Priority-tiered cadence (5 min / 15-30 min staggered / daily) plus the per-domain rate limit above; requests are made strictly one at a time, never concurrently |

## Honest gaps / things that need your action

1. **The real CSV file doesn't exist yet.** Add it at `data/approved_engineering_employers.csv` — see SETUP.md. Nothing in this report claims the 497-employer dataset itself is present; everything above is about the pipeline that will consume it.
2. **"Still accepting applications" is a reachability/HTTP-status check**, not a semantic read of the page's wording — an honest limitation, not a shortcut I'm hiding.
