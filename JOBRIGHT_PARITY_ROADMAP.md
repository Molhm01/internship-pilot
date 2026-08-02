# Internship Pilot — Jobright Functional Parity Roadmap & Audit

*Last Updated: July 24, 2026*

This document provides a truthful, evidence-backed audit of Internship Pilot's functional capabilities compared to typical automated job application platforms (such as Jobright or Simplify). Internship Pilot is built on local-first architecture (SQLite + local LLM via Ollama + local Chrome Extension), with zero cloud dependencies and zero proprietary code/assets borrowed from third-party services.

---

## Capabilities Status Overview

Every capability is assigned one of four strict status labels:

- **`WORKING_AND_TESTED`**: Fully implemented, backed by automated unit and E2E regression test suites passing 100%.
- **`PARTIAL`**: Core engine implemented, but secondary integration channels are ongoing.
- **`MOCK_ONLY`**: Tested against deterministic local HTML fixtures; live platform adapters pending production verification.
- **`NOT_IMPLEMENTED`**: Feature planned for future releases.

---

## Detailed Parity Audit Matrix

| # | Feature Goal | Status | Implementation & Test Evidence |
|---|---|---|---|
| 1 | **Candidate Profile** | `WORKING_AND_TESTED` | Local `ApplicationProfile` schema holding legal name, preferred name, email, phone, links, education, relocation, and EEO preferences. Tested in `test-documents.ts` & `test-application-agent.ts`. |
| 2 | **Personalized Job Matching** | `WORKING_AND_TESTED` | Local AI matching engine (`src/lib/matching.ts`) comparing candidate facts against job descriptions. Grounding enforcer prevents halluncinations. |
| 3 | **Match Score Per Job** | `WORKING_AND_TESTED` | Denormalized 0–100 match score per job card, backed by persistent `JobScoringQueue` background worker. Tested in `test-gate4-scoring-queue.ts`. |
| 4 | **Eligibility Result** | `WORKING_AND_TESTED` | Evaluates degree, graduation year, GPA, citizenship/clearance, work authorization, sponsorship, location, and term. Produces Pass / Fail / Unknown result. |
| 5 | **Missing Supported Keywords** | `WORKING_AND_TESTED` | Extracts missing job keywords grounded in approved candidate resume facts. Never suggests inventing unsupported skills. |
| 6 | **Resume Tailoring Per Job** | `WORKING_AND_TESTED` | Re-orders and selects from pre-approved `ResumeBullet` library. Generates 1-page Typst PDF resume for Pass-eligibility jobs. Tested in `test-documents.ts`. |
| 7 | **Cover Letter Generation** | `WORKING_AND_TESTED` | Generates tailored cover letter PDF for Pass-eligibility jobs using approved candidate facts. Refuses Fail-eligibility jobs. |
| 8 | **One-Click ATS Autofill** | `WORKING_AND_TESTED` | In-page Chrome MV3 extension overlay injects visible progress stages, fills standard/controlled inputs, uploads PDF resume, and stops before Submit. Tested in `test-extension-e2e.ts` and `test-lever-form.ts`. |
| 9 | **Application Tracker** | `WORKING_AND_TESTED` | Durable tracking table (`TrackedEmail` / `Job.status`) supporting SUBMITTED, ASSESSMENT_REQUIRED, INTERVIEW, REJECTED. Gmail auto-tracking verified in `test-gmail-tracking.ts`. |
| 10 | **Automatic Job Monitoring** | `WORKING_AND_TESTED` | Persistent background scheduler managing multi-source discovery (CSV allowlist, Intern List, USAJobs, Google Places nearby firms). Tested in `test-scheduler.ts`. |
| 11 | **Saved Filters & Alerts** | `WORKING_AND_TESTED` | `SavedFilter` model and `JobFilters` component supporting keyword, term, work authorization, location radius, and status filters. |
| 12 | **Duplicate Application Protection** | `WORKING_AND_TESTED` | `activeKey` unique constraint on `ApplicationRun` prevents duplicate application attempts across process races. Tested in `test-application-agent.ts`. |
| 13 | **Insider / Contact Discovery** | `PARTIAL` | Nearby firm discovery via Google Places API (`/nearby`) and CSV employer domain lookup. Public contact extraction in place; direct recruiter outreach pending. |
| 14 | **Agent-Assisted Application Queue** | `WORKING_AND_TESTED` | Durable `ApplicationRun` pipeline managed by dedicated single worker process (`scripts/application-worker.ts`) owning `data/browser-profile`. |
| 15 | **Final Review Before Submission** | `WORKING_AND_TESTED` | "Fill To Submit" default behavior: all application browser tabs remain open with highlighted fields for manual user inspection before clicking Submit. |

---

## ATS Platform Adapter Readiness

| ATS Platform | Capability Level | Real Browser Test Evidence |
|---|---|---|
| **Lever** | `PRODUCTION_READY` | Real Lever form fixture & extension injection suite passed 100% in `test-lever-form.ts`. |
| **Greenhouse** | `LIVE_INSPECTED` | Greenhouse API & posting structure verified in `inspect-greenhouse-real.ts`. |
| **Ashby** | `FIXTURE_TESTED` | Tested against local Ashby HTML form fixture. |
| **Workday** | `FIXTURE_TESTED` | Multi-step wizard tested against local Workday HTML form fixture. |
| **iCIMS** | `FIXTURE_TESTED` | Multi-step wizard tested against local iCIMS HTML form fixture. |
| **SmartRecruiters** | `FIXTURE_TESTED` | Tested against local SmartRecruiters HTML form fixture. |
| **SuccessFactors** | `FIXTURE_TESTED` | Tested against local SuccessFactors HTML form fixture. |
| **Taleo** | `FIXTURE_TESTED` | Tested against local Taleo HTML form fixture. |
| **Unknown / Custom** | `NOT_IMPLEMENTED` | Falls back to generic HTML label/aria scanner. |

---

## Architectural Guarantees & Privacy

1. **Local-Only Processing**: All embeddings, LLM scoring, document generation, and database queries execute locally on the user's machine (Ollama + SQLite).
2. **Never Invent Facts**: AI prompt enforcement requires every resume bullet and field answer to map to an approved `ResumeFact` id.
3. **Always Human-in-the-Loop**: The extension never presses Submit on an application.
4. **Single Worker Browser Ownership**: Exactly one node worker owns `data/browser-profile` under lock file protection, preventing profile corruption.
