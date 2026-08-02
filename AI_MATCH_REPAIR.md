# AI Match repair trace

## Active job-detail path

- **Button/component:** `src/app/jobs/[id]/page.tsx`, in `JobDetailPage`, renders **Run AI Match** / **Re-run AI Match**.
- **Click handler:** `runMatch()` in that component calls `requestManualMatch(id)`, then reloads the job and audit log. The same page renders an inline `matchError`.
- **Browser request:** `src/lib/matchWorkflow.ts` sends `POST /api/match` with JSON `{ "jobId": <current job id> }`.
- **API route:** `src/app/api/match/route.ts`. A manual `jobId` request directly awaits `runMatchForJob(jobId)`; it does not enqueue an ApplicationSession or application worker task.
- **Matching service/model:** `src/lib/matching.ts` builds the evidence-only prompt with `buildMatchPrompt`, calls `ollamaGenerateJSON`, validates with `matchResponseSchema`, and applies `enforceGrounding`.
- **Candidate source:** approved or edited `ResumeFact` rows, ordered oldest-first. Those rows contain the approved education, coursework, skills, projects, experience, and activities. Before this repair, the singleton `ApplicationProfile` was not loaded by AI Match.
- **Job-description source:** the current `Job` row. `matchJobDescriptionText` combines `description`, `jobResponsibilities`, and `jobQualifications`; official capture/verification writes official text into those canonical fields when available.
- **Persistence:** one append-only `MatchResult` row per successful run plus the current `Job.matchScore` and `Job.eligibilityStatus`, written in one Prisma transaction. Failed runs do not create a row or update the current score.
- **Refresh/display:** `GET /api/jobs/[id]` returns `matchResults` newest-first. `JobDetailPage` reads only `job.matchResults[0]` and renders score, eligibility reason, explanation, recommendation, supported qualifications, confirmation/missing qualifications, skills to learn, never-claim items, and `createdAt`.

## Other implementations

- `src/components/JobCard.tsx` is another live manual-match button. It uses the same `requestManualMatch` helper and canonical `/api/match` route.
- The Jobs-page bulk buttons call `/api/match` with `allUnscored` or `rescoreStale`; those are background-scoring controls and are not used by the job-detail button.
- `src/lib/matching/scoringQueue.ts` invokes the same matching service for bulk scoring. It is not part of the manual detail-page request.
- No second or abandoned manual matching engine was found. ApplicationSession, the application queue/worker, tailored-document generation, and autofill are separate paths.

## Reproduced regression boundary

- The browser helper has no `AbortController` or timeout, so a pending fetch keeps the button in `Matching…` indefinitely and prevents the page's `finally` from running.
- The page stores matching as one boolean rather than state keyed by job ID, so state can carry across a dynamic job navigation.
- The model deadline is 180 seconds and is not represented as a stable structured API error.
- The model schema accepts fractional scores and uses defaults for required arrays, allowing incomplete model output to be persisted instead of rejected.
- The API returns the legacy `{ matchResult }` / `{ error }` shapes rather than one structured success/failure contract.

## Repaired contract

- Manual matching now returns `{ ok: true, match }` or `{ ok: false, error, message }`; the public match contains only qualification labels and grounded summary text, while evidence IDs remain in the stored `MatchResult`.
- The browser request has a 60-second abort boundary and job-keyed loading state; the model request has a 45-second boundary.
- Model scores must be integers from 0 through 100 and every result array is required before the atomic append-only transaction can run.
- Unsupported positive claims are moved to `skillsNeverAdd`; exact degree, authorization, certification, and years-of-experience claims require exact approved evidence.
