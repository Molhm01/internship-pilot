# Phase 1 Recovery Audit

Date: 2026-08-01

Scope inspected:

- `C:\Users\Molhm\Desktop\Internship-AI`
- `C:\Users\Molhm\Desktop\Internship-Agent`

This document records the live paths before the Phase 2 implementation edits
made for this recovery. No ApplicationSession, extension-autofill, or legacy
worker implementation is part of Phase 2.

## Live Run AI Match UI

There are two visible manual match controls:

1. `src/app/jobs/[id]/page.tsx` owns the primary job-detail control. It is not
   a separate component. `runMatch()` posts `{ jobId: id }` to `/api/match`,
   reloads the job and audit log after success, and renders `matchError`
   inline. The button text is `Run AI Match` or `Re-run AI Match`.
2. `src/components/JobCard.tsx` renders `Run AI Match Now` on every card. It
   posts `{ jobId: job.id }` to `/api/match`, but currently discards the
   response and suppresses network failures.

Both controls are visible. Before Phase 2, neither checks whether the saved
job description is usable. The detail button is disabled only while a request
is running; the card button is never disabled.

## API route and backend function

The active route is `POST src/app/api/match/route.ts`.

- A body containing `jobId` calls `runMatchForJob(jobId)` synchronously and
  returns `{ matchResult }` only after the result has been persisted.
- `allUnscored` and `rescoreStale` still use
  `src/lib/matching/scoringQueue.ts` for bulk/background scoring.
- `MatchError` status/message values are returned as JSON errors.

The active backend function is `runMatchForJob` in `src/lib/matching.ts`.
It builds the prompt with `buildMatchPrompt`, calls the local Ollama model,
validates the response with `matchResponseSchema`, applies
`enforceGrounding`, persists the result, and writes an audit-log entry.

The manual path has no import of or call to ApplicationSession, the
Internship-Agent service, or the legacy Fill To Submit worker. The audit-log
helper it imports only writes `AuditLogEntry` data.

## Candidate/profile data read by matching

`runMatchForJob` reads `ResumeFact` rows whose status is `approved` or
`edited`, ordered by `createdAt`. For each fact it uses:

- `id`
- `type`
- `content`
- `detail`

Pending and rejected facts are excluded. The matcher does not read
`ApplicationProfile`, `ApplicationSession`, browser-extension state, uploaded
resume text, generated documents, or legacy application-worker state.

The browser sends only the selected `jobId`; the server loads the authoritative
job and approved profile facts from Prisma rather than trusting client-supplied
profile text.

## Job-description data read by matching

`runMatchForJob` loads the `Job` row by the supplied id. `buildMatchPrompt`
uses:

- `title`
- `company`
- `location`
- `internshipTerm`
- `duration`
- `description`

The matching prompt does not currently use the separately stored
`jobResponsibilities` or `jobQualifications` JSON fields. Before Phase 2,
the engine does not reject an empty/whitespace/placeholder description.

## Score and result persistence

`runMatchForJob` uses one Prisma transaction to:

- append a `MatchResult` row containing eligibility, score, explanation,
  recommendation, all four qualification buckets, grounded tailoring preview,
  and the approved fact ids used; and
- update `Job.matchScore` and `Job.eligibilityStatus` as denormalized latest
  values.

The job-detail API, `GET src/app/api/jobs/[id]/route.ts`, includes all
`matchResults` newest first. This is why a page refresh retains the result.
The jobs-list API includes the newest match result for each card.

## Result rendering

`src/app/jobs/[id]/page.tsx` renders the newest persisted result:

- score and eligibility through `MatchScoreBadge`
- eligibility reason and score explanation
- Apply/Skip/Consider recommendation
- grounded tailoring preview
- `skillsSupported`
- `skillsNeedConfirmation`
- `skillsToLearn`
- `skillsNeverAdd`

The four lists are rendered by `src/components/SkillBucket.tsx`. The latter
three buckets identify missing, unconfirmed, and unsupported qualifications.
Before Phase 2, grounding demotes unsupported supported-items, but model-written
reason text in non-supported buckets can still contain an invented statement
about the user.

## Tailored-document routes and UI still present

The following active routes remain:

- `POST src/app/api/jobs/[id]/generate-documents/route.ts`
- `GET src/app/api/jobs/[id]/documents/route.ts`
- `GET src/app/api/documents/[id]/download/route.ts`

The active generator is `generateDocumentsForJob` in
`src/lib/documents/generate.ts`. The job-detail page still renders the
`Tailored documents` section, generate/regenerate control, latest valid resume
and cover letter, PDF links, QA results, previous valid versions, invalid
archives, and tailoring audit metadata. These paths are documented only; they
are not changed in Phase 2.

## Current Apply behavior

The active Apply controls in `src/app/jobs/[id]/page.tsx` and
`src/components/JobCard.tsx` call `openStoredApplicationUrl(job)` from
`src/lib/jobs/applicationUrl.ts`. The helper selects a validated stored
official destination and opens it in a new tab with `noopener,noreferrer`.

If no canonical application URL exists but a source listing does, the UI shows
`Open source listing` and an unresolved-destination message instead.

The active controls do not call `/api/jobs/[id]/apply`,
`/api/application-sessions`, Internship-Agent, or the legacy worker. The old
apply route and application-run history/retry UI still exist as disconnected
legacy paths.

## Current job URL fields

Canonical destination fields:

- `sourceListingUrl`
- `officialApplicationUrl`
- `originalJobPostUrl`
- `resolutionStatus`
- `resolutionMethod`
- `resolvedAt`
- `resolutionError`

Description provenance fields:

- `jobDescriptionSourceUrl`
- `jobDescriptionHash`
- `jobDescriptionCapturedAt`

Legacy/compatibility URL fields still stored:

- `url`
- `sourceUrl`
- `officialJobUrl`
- `officialApplyUrl`
- `redirectChain`

`src/lib/jobs/applicationUrl.ts` prefers the canonical destination fields but
still contains validated legacy fallbacks.

## Recent regressions and disconnected code

Git history is unavailable for the website, so these findings come from live
call paths and file timestamps:

- The manual route had been changed to return only a scoring-queue
  acknowledgement. The current file already contains a local, uncommitted
  reconnection to `runMatchForJob`, while preserving the queue for bulk work.
- The job-card control still ignores non-2xx responses and network failures,
  so it can fail with no user-visible explanation.
- Both manual controls allow matching without validating the job description.
- The grounding layer verifies supported-item fact ids/text and replaces the
  model's top-level explanation, but it still trusts model-authored reason text
  for missing/unconfirmed/unsupported items.
- The old `POST /api/jobs/[id]/apply` worker enqueue path and historical worker
  UI still exist but are not called by the live Apply controls.
- `src/lib/matching/scoringQueue.ts` remains valid for automatic and bulk
  scoring; it should not replace synchronous behavior for a manual click.

## Current uncommitted changes

At audit time, `Internship-AI` had no `.git` directory and was not inside a Git
worktree. Therefore no reliable pre-recovery website diff or commit history
could be produced, and the existing local Phase 2-looking files could not be
distinguished from a clean baseline by Git. A new repository may be initialized
after verification solely to make the requested recovery commit.

`Internship-Agent` is a separate Git repository and currently has pre-existing
uncommitted changes in ApplicationSession, extension background/popup, shared
schemas/client tests, and extension/server tests, plus untracked local planning
and standalone-extension files. Those changes are out of scope and will not be
modified or committed in this recovery.

## Relevant existing tests

- `src/app/api/match/route.test.ts`: manual route returns a completed match,
  exposes a `MatchError`, and retains the queue for bulk requests.
- `src/lib/validation.test.ts`: grounding keeps supported items only when an
  approved fact id and text overlap exist, and forces Fail to Skip.
- `scripts/test-job-scoring.ts`: live Ollama/database score shape and buckets.
- `scripts/test-scoring-queue.ts`: background queue persistence and priority.
- `scripts/test-gate4-scoring-queue.ts`: legacy queue counters and priority.
- `src/app/api/jobs/[id]/generate-documents/route.test.ts` and
  `src/lib/documents/recovery.test.ts`: tailored-document route/generator
  coverage; outside Phase 2.
- `src/lib/jobs/applicationUrl.test.ts`, `src/lib/jobs/applyFlow.test.ts`, and
  official-destination tests: current direct Apply URL selection; outside the
  matching change.

Missing focused proof before Phase 2:

- engine persistence with the authoritative job plus approved/edited facts
- missing job-description rejection before a model call
- UI request normalization that keeps model/network failures inline
- sanitization proving unsupported qualification text is never rendered as a
  user fact

## Phase 2 repair boundary

Phase 2 should retain the existing matching engine and persistence model. The
required repair is limited to validating usable job descriptions, making both
live controls surface errors safely, strengthening the existing grounding
sanitizer for unsupported qualification reasons, and adding focused tests.
ApplicationSession, extension autofill, the legacy Fill To Submit worker, and
tailored-document implementation remain untouched.
