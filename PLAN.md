# Internship Pilot — Phase 1 Plan

## Goal
A local-only Windows web app that helps track internship applications, using a local
Ollama model (`qwen3.5:9b`) for resume parsing and AI-assisted job matching. No
scraping, no browser automation, no auto-submission in Phase 1.

## Stack
- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- Prisma ORM + SQLite (file: `prisma/dev.db`)
- Ollama local server (`http://localhost:11434`, model `qwen3.5:9b`)
- No Docker, no cloud services — everything runs on localhost.

## Data Model (Prisma)
- `ResumeFact` — one row per extracted fact (type: education/gpa/graduationDate/
  coursework/skill/project/experience/activity, content, status: pending/approved/
  edited/rejected)
- `Job` — title, company, location, postingDate, internshipTerm, duration, url,
  description, status (tracker status enum), timestamps
- `MatchResult` — jobId, eligibility (Pass/Fail/Unknown), score (0-100), explanation,
  skillsSupported/skillsNeedConfirmation/skillsToLearn/skillsNeverAdd (JSON arrays),
  createdAt

## Pages / Routes
1. `/profile` — paste resume textarea, "Analyze Resume" button → calls
   `/api/resume/analyze` (Ollama) → returns structured facts → user approves/edits/
   deletes → "Save Approved Facts" persists to DB via `/api/resume/facts`.
2. `/jobs` — manual job entry form + saved job list with filters (location, posting
   date, term, duration, status). Job cards link to a detail view.
3. `/jobs/[id]` — job detail, "Run AI Match" button → calls `/api/match` → shows
   eligibility, score, explanation, and the 4 skill buckets, all citing resume facts.
   Status changer (tracker dropdown).
4. `/tracker` — kanban-style board of all jobs grouped by status column, drag-free
   (use simple dropdown/buttons per beginner-friendly requirement) to move between
   statuses.
5. Left navigation shell (Profile, Jobs, Tracker) used across all pages.

## API Routes
- `POST /api/resume/analyze` — send resume text to Ollama, parse JSON facts.
- `GET/POST/PATCH/DELETE /api/resume/facts` — CRUD approved facts.
- `GET/POST /api/jobs`, `GET/PATCH/DELETE /api/jobs/[id]` — job CRUD + status update.
- `POST /api/match` — build a grounded prompt from approved facts + job description,
  call Ollama, parse structured match result, store `MatchResult`.
- `GET /api/health/ollama` — connectivity test used by the test script and UI.

## Guardrails for AI honesty
- Prompts explicitly instruct the model to only use facts present in the approved
  resume facts list, to output strict JSON, and to mark anything not evidenced as
  "unknown"/"skills to learn"/"never add" rather than inventing it.
- Server-side validation: any skill claimed as "supported" must fuzzy-match text in
  an approved fact; otherwise it gets downgraded to "possibly supported" and
  flagged, not silently trusted.

## Testing (before calling it done)
- `scripts/test-ollama.ts` — hits Ollama `/api/tags` and a tiny generate call.
- `scripts/seed.ts` — inserts sample resume facts + 2-3 sample jobs.
- Manual smoke test: analyze a sample resume, approve facts, create a job, run
  match, move a job through tracker statuses.
- `npm run build` to catch TypeScript/build errors.

## Out of scope in Phase 1 (addressed in Phase 2 below)
- Automatic job discovery
- Application submission (still out of scope — see Phase 3)

---

# Phase 2 — Automatic Internship Database

## Source & compliance notes
- Primary source: `intern-list.com/?k=eng`, which embeds a Jobright "minisite"
  iframe (`jobright.ai/minisites-jobs/intern/us/engineering_development`) — that
  page is the actual public listing and exposes job data as server-rendered JSON,
  so a plain HTTP fetch is used (Playwright is a fallback only, in
  `internListAdapter.ts`, in case the page ever stops SSR-embedding the data).
- `jobright.ai/robots.txt` disallows `/api/*` for everyone and specifically
  disallows `/jobs/` for ClaudeBot. Per user decision, we do NOT call `/api/*`
  (so each sync covers only the newest ~50 postings, not a full 500-job
  backfill) and do NOT follow jobright's own apply-redirect
  (`/jobs/info/<id>`) — instead we independently verify against official
  Greenhouse/Lever/Ashby public job-board APIs.
- No LinkedIn/Indeed/Handshake scraping, no login/CAPTCHA bypass, no private or
  reverse-engineered APIs.

## New modules
- `src/lib/sync/internListAdapter.ts` — fetch + parse the source; fixture-testable
  via `parseInternListPayload`.
- `src/lib/sync/classify.ts` — heuristic, fully local classification (discipline
  tags, season, sophomore eligibility, grad years, sponsorship, citizenship/
  clearance mentions, compensation parsing, distance from Clifton NJ via a
  hardcoded city table — no external geocoding service).
- `src/lib/sync/ingest.ts` — dedup + upsert (by source+sourceJobId, else
  company+normalized title+location).
- `src/lib/sync/verify.ts` — independent verification against Greenhouse/Lever/
  Ashby's public job-board APIs; never trusts a match without title+location
  alignment; never fabricates an official URL.
- `src/lib/sync/discover.ts` / `queue.ts` — discovery sync + a 2-minute queue
  that verifies newly-discovered jobs and re-checks aging "Verified" ones.
- `src/lib/sync/scheduler.ts` + `scripts/scheduler-worker.ts` — the schedule runs
  in its own Node process, started by `npm run local`, NOT by the Next.js
  server: immediate first sync, hourly discovery, 2-minute queue processing.
  `src/instrumentation.ts` deliberately starts nothing; importing the scheduler
  there dragged pg/pgpass Node built-ins into the Windows Webpack bundle and
  broke the website build.
- `src/lib/matching.ts` — the Phase 1 scoring logic, extracted so both the
  manual "Run AI Match" button and the automatic post-verification scoring
  share one implementation.

## Testing
- `scripts/fixtures/intern-list-sample.json` — a real saved 50-job payload, used
  so tests never have to hit Intern List repeatedly.
- `npm run test:sync` — parsing, initial sync, duplicate prevention, new/changed
  detection, migration integrity.
- `npm run test:verify` — mocked Greenhouse/Lever/Ashby responses covering a
  clean match, a location mismatch, a not-found case, and closed-posting
  detection.
- `npm run test:filters` — discipline/eligibility/distance/compensation/grad-year
  filters against the live API, plus an end-to-end verify→auto-score check.

---

# Phase 2 completion status (Milestones 1-9)

All nine milestones are implemented and tested. See `SETUP.md` for what still needs your own
credentials (Gmail OAuth client, USAJOBS key, Google Places key — all optional).

- **M1** Nationwide verified search, Company Watchlist — `npm run test:nationwide`
- **M2** Nearby Engineering Firms (Google Places, optional key) — `npm run test:nearby`
- **M3** Strict VERIFIED_OFFICIAL gate + Quarantine — `npm run test:strict-verification`
- **M4** Persistent scheduler, pause/resume, Windows auto-launch — `npm run test:scheduler`
- **M5** Documents: locked facts, bullet library, Typst resume/cover-letter generation, QA,
  anti-fabrication grounding filter — `npm run test:documents`
- **M6** Application Agent: modes (Off/Fill Only/Auto-Submit Allowlist), Playwright adapters
  (Greenhouse/Lever/Ashby tested against local mock forms; Workday/SmartRecruiters/iCIMS/
  Taleo/SuccessFactors detected but not yet enabled for autofill), 13-step worker pipeline,
  NEEDS_USER_ACTION stop conditions — `npm run test:application-agent`. **AUTO_SUBMIT_ALLOWLIST
  has never been exercised against a real employer site — only local mock fixtures.**
- **M7** Gmail tracking (read-only OAuth, classification, job matching, Assessment Inbox,
  Windows notifications) — built through the Google Cloud credential wall; classification/
  matching/tracker-update logic fully tested via fixtures — `npm run test:gmail-tracking`
- **M8** Tracker status vocabulary (16 states), permanent audit log, activity timeline UI
- **M9** Security review (no token/password/cookie/PII logging), full regression pass across
  all `test:*` scripts, `SETUP.md`

A stale-Prisma-client bug in the long-running dev server (from before the M6-M8 schema
migrations) was found and fixed during the final regression pass — restart the dev server after
any future `prisma migrate dev` if you see "Cannot read properties of undefined" errors.

---

# 2026-07-22 handoff audit and document-system repair

## Completed and verified

- Replaced the flat resume renderer with a fixed one-page, US Letter, single-column Typst template.
- Added a non-empty name/contact header, separate NJIT and Stevens entries, categorized technical
  skills, compact coursework, structured experience, named projects, technologies, and real bullets.
- Removed duplicated `Expected`, detached GPA output, soft-skill keyword stuffing, and unsupported
  job-description keywords. GPA is omitted unless its approved evidence explicitly names the school.
- Reworked cover letters to use a fixed greeting/closing/current date and deterministic prose assembled
  from selected approved facts. No free-form company claims are inserted into the final letter.
- Expanded document QA for candidate/contact presence, required non-empty sections, heading/read order,
  duplicated `Expected`, selected project titles, placeholders/banned phrases, one-page output, minimum
  resume content, and 180-300-word cover letters.
- Generated Astranis regression versions `resume-v5` and `cover-letter-v5`; both passed automated QA
  and were rendered to PNG for visual inspection.
- Production build, lint (warnings only), document tests, and all project regression suites pass after
  hardening malformed local-model resume facts. No real application was sent.

## Truthful capability status

- **Real:** local profile/fact management, PDF upload/extraction, matching, document generation/QA,
  strict official-listing verification, tracker, scheduler, fraud quarantine, and Gmail read-only logic.
- **Real but optional/configuration-dependent:** employer CSV monitoring, Google Places nearby search,
  Gmail OAuth, and local Ollama inference.
- **Simulated/tested only:** ATS form filling and submission behavior against local mock pages.
- **Partial:** live ATS coverage varies by employer/login flow; unknown fields, CAPTCHA, MFA, assessments,
  terms, and unsaved sensitive answers stop for user action.
- **Unimplemented/not approved:** unattended submission to real employers. `FILL_TO_SUBMIT` is the safe
  default; `AUTO_SUBMIT_ALLOWLIST` must not be enabled without explicit user approval.
