# Autofill Readiness Report

Generated from actual test runs and code inspection on 2026-07-22. No real application has ever
been submitted to a real employer site during development — every "submitted" result below was
against a local mock fixture served from this app's own `public/mock-ats/` folder.

## Candidate Profile

| Field group | Status | Notes |
|---|---|---|
| Legal + preferred name | **PASS** | `ApplicationProfile.fullName` / `.preferredName` |
| Address + contact (street/city/state/zip, phone, email) | **PASS** | |
| LinkedIn, GitHub, portfolio | **PASS** | |
| Current school (NJIT) + previous school (Stevens) | **PASS** | `school` / `previousSchool` fields |
| Degree/major/GPA/graduation date/coursework | **PASS** | Lives in the locked `ResumeFact` table (Milestone 5), rendered directly onto the resume with zero LLM involvement |
| Work experience, projects, skills | **PASS** | Same locked-fact system, surfaced through the reusable bullet library |
| Work authorization, sponsorship | **PASS** | Null by default — the agent stops and asks rather than guessing |
| Willingness to relocate, location preferences | **PASS** | Added this session; `npm run test:application-agent` scenario 8 confirms it fills correctly |
| Internship-term availability | **PASS** | Scenario 9 |
| Salary-answer preference | **PASS** | Scenario 8 |
| Previously approved application answers (reused across applications) | **PASS** | `ApprovedAnswer` model — after a stop on an unrecognized question, you can type the answer once on the job page and it's reused for the identical question on future applications. Never applied to sensitive categories (EEO/work-authorization), which always re-ask. |
| Voluntary demographic-answer preferences (EEO) | **PASS** | Null by default, stop-and-ask unless explicitly set |
| Master resume + optional master cover letter | **PASS** | Milestone 5, preserved untouched — every generated document is a SEPARATE file |
| Never guesses missing info; asks once, saves securely | **PASS** | Every profile field defaults to null/unset; the agent's `unknown_question` / `eeo_no_saved_preference` / `citizenship_clearance_sponsorship_ambiguous` stop conditions exist specifically so it never guesses |

## Truthful document tailoring

| Step | Status | Notes |
|---|---|---|
| 1. Compare job description against approved evidence | **PASS** | `selectContentForJob()` |
| 2. Select only truthful, supported skills/experience | **PASS** | Bullet selection is a closed set — the model can only choose EXISTING bullet IDs, never write new ones |
| 3. Reorder/rephrase supported bullets for relevance | **PASS** | Selection + ordering only; underlying bullet text itself was pre-generated once from approved facts |
| 4. Never adds an unearned technology/duty/project/result/cert/skill | **PASS** | Structurally impossible for resume bullets (selection-only); for cover-letter prose (the one free-form surface), `filterGroundedSentences()` rejects any sentence with an unsupported specific claim — `npm run test:documents` |
| 5. Preserves the original master resume | **PASS** | Original upload untouched in `data/resumes/`; generated docs live separately per job |
| 6. Generates a job-specific resume via the fixed Typst template | **PASS** | `templates/resume-template.typ` |
| 7. Generates a cover letter when useful | **PASS** | Only when eligibility isn't Fail and content was actually selected |
| 8. PDF layout checks (merged words, spacing, overflow, reading order, page count) | **PASS** | `evaluateDocumentQa()` — re-extracts the compiled PDF's text and checks it, rather than trusting the source `.typ` file |
| 9. Documents stored with their application | **PASS** | `GeneratedDocument` linked to `Job`, referenced by `ApplicationRun.resumeDocumentId` |
| Every statement retains links to evidence IDs; unsupported statements rejected | **PASS** | `factIds` on every bullet; grounding filter rejects ungrounded cover-letter sentences |

## Application Agent

| Requirement | Status | Notes |
|---|---|---|
| Persistent Playwright-managed browser profile | **PASS** | `src/lib/applications/browserProfile.ts` — one on-disk Chromium profile reused across runs and restarts |
| **Greenhouse** adapter, tested | **PASS** | `npm run test:application-agent` scenario 1-2 |
| **Lever** adapter, tested | **PASS** | Scenario 2 |
| **Ashby** adapter, tested | **PASS** | Scenarios 3-4 |
| **Workday** adapter, tested | **PASS** | Scenario 6 — 2-step wizard, auto-submit through both steps |
| **iCIMS** adapter, tested | **PASS** | Scenario 7 — 2-step wizard with a mid-wizard stop |
| **SmartRecruiters** adapter, tested | **PASS** | Scenario 8 |
| **SuccessFactors** adapter, tested | **PASS** | Scenario 9 |
| **Taleo** adapter, tested | **PASS** | Scenario 10 |
| Reusable field matching (name/contact, address, education, work history, projects, skills, resume upload, cover-letter upload, work auth, sponsorship, relocation, availability, repeated questions) | **PASS** | `src/lib/applications/answerBank.ts` — every category above has a dedicated classifier + lookup, covered across the 10 test scenarios |
| Unknown questions: never invented, added to NEEDS_ACTION | **PASS** | `unknown_question` / `essay_without_approved_answer` / `requested_info_not_stored` stop reasons; the job page shows the exact question text and lets you answer + save it |

**Honesty note on ATS scope**: all 8 adapters share one generic, label-scanning, multi-step-aware
engine rather than 8 separate hand-built ones — this is more robust to real-world markup
differences than hardcoded per-ATS selectors would be, but it means "tested" here means "tested
against a local mock shaped like that platform's typical flow," not against a specific real
employer's live instance. A real Workday tenant that requires creating a candidate account before
applying, for example, would hit the `login_required` stop condition (a password field appearing)
rather than fail silently, since that specific flow was never modeled.

## Application modes

| Requirement | Status | Notes |
|---|---|---|
| **OFF** — discovery/tracking only | **PASS** | Default. `worker.ts` refuses to run at all in this mode. |
| **FILL_TO_SUBMIT** (default active mode) — fills every known field, uploads tailored documents, validates, stops on final review | **PASS** | Never calls the Submit click in this mode (`formFiller.ts`) |
| Keeps the completed application browser open | **PASS** | Fill-To-Submit launches the persistent browser HEADED (visible); Auto-Submit stays headless since no review is expected |
| Highlights unanswered fields | **PASS** | Optional fields left blank get a visible amber outline injected into the live page |
| Shows the tailored resume/cover letter, every answer entered, verification evidence | **PASS** | Job detail page: documents section, full answers map per run, verification evidence panel |
| "Ready for your final review" notification | **PASS** | Windows toast notification fires the moment a Fill-To-Submit run reaches `filled` status |
| Does not click Submit in this mode | **PASS** | Verified across every Fill-To-Submit test scenario (never returns `confirmationNumber`) |
| **AUTO_SUBMIT_ALLOWLIST** — optional, disabled by default | **PASS** | `AppSetting` default mode is `OFF`; allowlist itself defaults empty |
| Only submits for explicitly approved employers + score threshold | **PASS** | `isCompanyAllowlisted()` + threshold check in `worker.ts`; any job outside the allowlist or below threshold automatically falls back to Fill-To-Submit rather than refusing outright |
| Always stops for CAPTCHA/MFA/login problems/assessments/unknown legal questions/unknown essays/failed uploads/eligibility ambiguity/website changes | **PASS** | Each has a dedicated, tested stop condition (`captcha`, `login_required`, `assessment_required`, `citizenship_clearance_sponsorship_ambiguous`, `unknown_question`, `essay_without_approved_answer`, `upload_failed`, `posting_closed_before_submit`) |
| Never submits to a real application during development | **PASS** | Every "submitted" test result in this project points at a `public/mock-ats/*.html` file served by this app itself |

## Testing and proof — the 10-step pipeline

Every step below was proven end-to-end against the real local system (real Ollama model, real
Typst compiler, real Playwright browser, real SQLite database) — not described, actually run:

1. **Discover an internship from an approved source** — `npm run test:sync` (Intern List) / `npm run test:nationwide` (Company Watchlist + live Greenhouse board) — PASS
2. **Verify its official source chain** — `npm run test:verify`, `npm run test:strict-verification` — PASS
3. **Score it** — `npm run test:jobs`, `npm run test:filters` (automatic scoring after verification) — PASS
4. **Generate truthful tailored documents** — `npm run test:documents` (12/12 checks, including rejecting an unsupported statement) — PASS
5. **Open a multi-page application** — `npm run test:application-agent` scenarios 6-7 (Workday/iCIMS 2-step wizards) — PASS
6. **Autofill contact, education, experience, projects, required questions** — all 10 application-agent scenarios — PASS
7. **Upload the correct documents** — verified in scenarios 1, 2, 6 (resume filename appears in the recorded answers) — PASS
8. **Stop on the final Submit page** (Fill-To-Submit) — scenario 1 — PASS
9. **Add the application to the tracker** — every scenario updates `Job.status` (`READY_TO_APPLY`/`SUBMITTED`/`NEEDS_USER_ACTION`/`FAILED`) and writes a permanent `AuditLogEntry` — PASS
10. **Recover after restarting the background worker** — `npm run test:scheduler` (all schedule state lives in SQLite; a restart resumes from what's due, verified this session after two dev-server restarts mid-work) — PASS

## Reports index

- `SOURCE_SECURITY_REPORT.md` — the discovery/verification/fraud-protection chain
- `SETUP.md` — what you still need to connect
- This file
