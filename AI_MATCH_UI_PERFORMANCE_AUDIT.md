# AI Match UI and job-detail performance audit

## Live request and state lifecycle

- The live button is in `src/app/jobs/[id]/page.tsx` (`JobDetailPage`). `runMatch()` holds an `AbortController` in `activeMatchRequests`, calls `runManualMatchAndRefresh`, and renders loading from `matchingJobs[id]`.
- `runManualMatchAndRefresh` in `src/lib/matchWorkflow.ts` sets job-keyed loading, awaits the AI Match POST, then awaits `refreshMatch`, and only clears loading in its final `finally`.
- The page's `refreshMatch` is `Promise.all([load(), loadAuditLog()])`. `load()` can update `job.matchResults[0]` and display the new persisted score while `loadAuditLog()` is still pending. Because the workflow still awaits the combined refresh, neither its loading cleanup nor the page handler's duplicate-request-lock cleanup runs. This exactly explains a new score and timestamp appearing while the button remains `Matching…`.
- There is no `router.refresh`, `revalidatePath`, URL-derived loading, database-derived loading, or persisted loading flag in this path. A browser reload creates fresh local state.
- No effect invokes `runMatch`; a rerender cannot automatically issue another AI Match POST. The explicit request map blocks a second click while the first handler remains active.

## Effects and automatic requests

The job-detail page has three effects before this repair:

1. Initial-load effect calls `load`, `loadDocuments`, `loadRuns`, and `loadAuditLog`. The requests begin concurrently, but React development Strict Mode can invoke the mount effect twice because it has no per-job duplicate guard.
2. Document-request cleanup aborts active document generation on job change/unmount.
3. Match-request cleanup aborts active matching on job change/unmount.
4. Application-run polling started whenever any loaded run was `queued` or `running`. Every 1.5 seconds it reloaded application runs, the full job, and the full audit timeline. It did not check tab visibility. Because `runs` was an effect dependency and every poll installed a new array, the interval was repeatedly torn down and recreated. This automatic polling has now been removed from the job-detail page.

`OllamaStatusBadge` performs one health request per mount. It has no shared cache or in-flight request deduplication, so Strict Mode mounts and job-page remounts can repeat the health request immediately. It has no polling interval of its own.

## Expensive reads and render work

- `GET /api/jobs/[id]` loads every historical `MatchResult`, although the page renders only the newest.
- `GET /api/jobs/[id]/audit-log` loads the complete append-only timeline without a limit.
- `GET /api/jobs/[id]/applications` loads all application runs without a limit.
- While a run is active, those large reads were repeated with the 1.5-second polling cycle.
- Document filtering/version grouping and large verification-evidence JSON parsing/pretty-printing run again on every render rather than being memoized.
- The page is a client component, so there is no job-page server-component render to time. Useful timing boundaries are the initial client load, individual API fetches, and their Prisma queries.

## Confirmed root causes

- **Stuck state:** loading and duplicate-lock cleanup were incorrectly coupled to a secondary job/audit refresh after the already-successful POST.
- **Lag:** active-run polling issued three requests every 1.5 seconds even in hidden tabs, unbounded history endpoints grew over time, development mounts could duplicate the four initial requests, health checks had no cross-mount throttle, and derived JSON/document calculations reran on every state update.
- **Duplicate AI Match POSTs:** none were found from rendering or effects. The duplicate traffic was GET traffic from initial Strict Mode effects, polling, and repeated Ollama badge mounts.

## Implemented performance boundaries

- Match loading and the active-request lock now finish from the POST lifecycle; local result rendering occurs before a non-blocking job/audit reconciliation.
- Initial page reads have a per-job Strict Mode guard and still begin in parallel.
- Automatic application-run polling is removed from the job-detail page. Application state is loaded once on page entry and after explicit application actions; there is no interval, visibility listener, or background match trigger.
- `/api/match` now accepts only a non-empty `jobId`. Legacy bulk payloads are rejected, and bulk-scoring controls were removed from the Jobs page.
- The production scheduler no longer starts or periodically wakes the legacy scoring drainer. Starting the website cannot initiate a queued bulk AI Match run.
- Ollama health uses one shared in-flight request and a 15-second cross-mount cache.
- The detail endpoint selects only the newest match, application history is capped at 50 rows, and activity history is capped at 100 rows. The underlying database history remains unchanged.
- Document groups and verification-evidence formatting are memoized.
- Development-only timing logs record the initial page load, job fetch, AI Match fetch, Ollama health fetch, document metadata fetch/query, application history fetch/query, and activity fetch/query without recording candidate or job content.
