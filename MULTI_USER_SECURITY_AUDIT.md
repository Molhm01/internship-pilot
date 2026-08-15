# Multi-user security audit

Internship Pilot is being converted from a single-user application into a hosted
multi-user one. This document is the inventory that conversion is planned
against: every model, every API route, and every storage key, classified by who
may see it.

It was produced by reading the schema, every file under `src/app/api`, and every
file under `src/lib` that touches a private Prisma model. Counts and route lists
below are mechanical, not sampled.

**Nothing in this document is a change.** It is the state of the system as
found, plus the plan of record.

---

## 0. Summary of what is wrong today

The application was built for one person on one machine, and its data model says
so. The specific consequences, in order of severity:

| # | Finding | Severity |
| - | ------- | -------- |
| 1 | 15 API routes read or write another person's private data with **no authentication of any kind** | Critical |
| 2 | `ApplicationProfile` is a **global singleton** (`id = "default"`) holding one human's legal name, address, phone, EEO answers and work authorization. Every signed-in user would read the same row. | Critical |
| 3 | `GET /api/documents/[id]/download` returns any generated résumé PDF **by id, unauthenticated**. Guessing or leaking one id is a full document disclosure. | Critical |
| 4 | The browser extension authenticates with **one global shared token** stored in `AppSetting`. Every user's extension would present the same secret and receive the same (one) profile. | Critical |
| 5 | `MatchResult` has no `userId`. Two users scoring the same job overwrite each other; a score is a statement about a person, stored globally. | High |
| 6 | Personal state lives **on the canonical `Job` row**: `status`, `matchScore`, `eligibilityStatus`. One user marking a job Submitted changes it for everyone. | High |
| 7 | `ResumeFact`, `ResumeDocument`, `ResumeBullet`, `GeneratedDocument`, `ApplicationRun`, `CompanyRelationshipFact`, `SavedFilter`, `GmailAccount`, `TrackedEmail`, `AssessmentInboxEntry` have **no owner column at all**. | High |
| 8 | `CompanyRelationshipFact.companyKey` is **globally unique** — one row per company for the whole installation, so the second user to answer "have you worked here?" overwrites the first. | High |
| 9 | `SavedFilter.name` is globally unique, and the code seeds a filter named after the original user. | Medium |
| 10 | Storage keys are `data/resumes/<documentId>.pdf` and `data/generated/<jobId>/…` — **not separated by user**. | Medium |
| 11 | `GmailAccount` is a singleton (`id = "default"`): one mailbox connection for the whole deployment. | High |
| 12 | Authentication is a bespoke scrypt + `UserSession` implementation, gated off entirely by `INTERNSHIP_PILOT_SINGLE_USER`, which **defaults to single-user**. A misread environment variable fails open. | High |
| 13 | There is **no route protection layer** — no middleware/proxy, and `(app)` pages render for anyone. | High |
| 14 | `AppSetting` mixes genuinely global scheduler config with per-person preferences (nearby-search centre and radius, application mode, auto-submit threshold and allowlist). | Medium |

None of this is a defect in the original build. It is what "one user, one laptop,
one SQLite file" correctly looks like. All of it is unacceptable hosted.

---

## 1. Model classification

`GLOBAL_SHARED` — one row serves every user; discovery infrastructure.
`USER_PRIVATE` — belongs to exactly one human.
`SYSTEM_INTERNAL` — machinery: run logs, queues, config. No personal content.

### 1.1 GLOBAL_SHARED — must stay shared, must NOT gain `userId`

| Model | Notes |
| ----- | ----- |
| `Job` | The canonical internship. Global except for three personal fields — see §2. |
| `Company` | Employer watchlist. |
| `ApprovedAtsTenant` | Evidenced employer→ATS tenant link. |
| `NewEmployerReview` | Employer approval queue. |
| `SecurityQuarantineEntry` | Fraud quarantine. |
| `VerificationAttempt` | Append-only verification history for a job. |
| `NearbyFirm` | Discovery staging record. |

### 1.2 USER_PRIVATE — already owned by a user

| Model | Owner column | Gap |
| ----- | ------------ | --- |
| `User` | — | Passwords are scrypt-hashed; fine. |
| `UserSession` | `userId` (cascade) | Replaced by Better Auth's session table. |
| `UserProfile` | `userId` unique | None. |
| `ApplicationPreferences` | `userId` unique | None. |
| `SensitiveAnswerPreferences` | `userId` unique | None. |
| `Education` | `userId` **nullable** | Nullable owner is a legacy escape hatch; legacy rows must be claimed and the column made required. |
| `Experience` | `userId` **nullable** | Same. |
| `Project` | `userId` **nullable** | Same. |
| `ApprovedAnswer` | `userId` **nullable** | Same. `@@unique([userId, questionText])` is already correct. |

### 1.3 USER_PRIVATE — **no owner today** (the core of this work)

| Model | Contains | Required change |
| ----- | -------- | --------------- |
| `ApplicationProfile` | Legal name, address, phone, EEO/demographics, work authorization, salary answers | Fields redistributed into `UserProfile` / `ApplicationPreferences` / `SensitiveAnswerPreferences` / `Education`; singleton retired. |
| `ResumeFact` | Facts extracted from a résumé | `userId` + cascade + index |
| `ResumeDocument` | Uploaded résumé PDFs and their extracted text | `userId` + cascade + index |
| `ResumeBullet` | Approved résumé prose | `userId` + cascade + index |
| `GeneratedDocument` | Tailored résumés and cover letters | `userId` + cascade + index; user-separated storage keys |
| `CompanyRelationshipFact` | "Have you worked here", referral names | `userId`; `@@unique([userId, companyKey])` |
| `MatchResult` | AI score and reasoning for a person against a job | `userId`; `@@unique([userId, jobId, …])` semantics |
| `ApplicationRun` | Every answer submitted to an employer | `userId` + index; `activeKey` becomes per-user |
| `SavedFilter` | Job-search presets | `userId`; `@@unique([userId, name])` |
| `GmailAccount` | OAuth refresh token for a mailbox | `userId` unique; singleton retired |
| `TrackedEmail` | Subject/sender/snippet of real email | `userId` + index |
| `AssessmentInboxEntry` | Assessment details from email | `userId` + index |

### 1.4 SYSTEM_INTERNAL

| Model | Disposition |
| ----- | ----------- |
| `AtsSyncRun` | Global. Discovery telemetry. |
| `SyncLog` | Global. |
| `InitialAiMatchJob` | Global **queue**, but it produces a `MatchResult`, which is per-user. Its uniqueness `@@unique([jobId, matchType])` must become per-user or the queue must record the user it scores for. |
| `AuditLogEntry` | Mixed. Rows with `actor = "user"`, `application-agent`, `gmail-tracking` describe one person's activity; `verification`/`ai-match`-on-discovery rows are global. Gains a nullable `userId`; personal writes must set it. |
| `AppSetting` | Mixed — see §5. |

---

## 2. Personal state on the canonical Job

Three columns on `Job` are statements about a person:

| Column | Meaning | Destination |
| ------ | ------- | ----------- |
| `status` | Tracker state (`TAILORING`, `QUEUED`, `SUBMITTED`, `INTERVIEW`, `REJECTED`, `OFFER`…) | `UserJobState.applicationStatus` |
| `matchScore` | Denormalized copy of the latest `MatchResult.score` | `UserJobState.matchScore` |
| `eligibilityStatus` | Denormalized copy of `MatchResult.eligibility` | `UserJobState.eligibilityStatus` |

`TRACKER_STATUSES` mixes two vocabularies. `DISCOVERED`, `VERIFIED`, `CLOSED`
describe the posting; the rest describe an application. The global lifecycle
already has better homes on `Job` (`verificationStatus`, `activeFeed`,
`classification`, `resolutionStatus`), so `Job.status` is personal in substance.

Everything else on `Job` — title, company, location, description, posting dates,
source metadata, official URLs, verification, ATS fields, classification,
`activeFeed`, scoring-queue state — stays global and untouched.

New model:

```prisma
model UserJobState {
  id                String   @id @default(cuid())
  userId            String
  jobId             String
  applicationStatus String   @default("DISCOVERED")
  saved             Boolean  @default(false)
  hidden            Boolean  @default(false)
  notes             String?
  matchScore        Int?
  eligibilityStatus String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([userId, jobId])
}
```

---

## 3. API route inventory

81 route files. Classified by whether they touch private data and whether they
authenticate.

### 3.1 Private data, NO authentication (15) — all must change

| Route | Private models reached |
| ----- | ---------------------- |
| `/api/application-bundle` | ResumeFact, ApplicationProfile, CompanyRelationshipFact, ApprovedAnswer, Education, Experience, Project |
| `/api/application-profile` | ApplicationProfile |
| `/api/application-sessions` | GeneratedDocument |
| `/api/applications/[id]/screenshot` | ApplicationRun |
| `/api/assessments` | AssessmentInboxEntry |
| `/api/documents/bullets` | ResumeBullet |
| `/api/documents/[id]/download` | GeneratedDocument |
| `/api/filters/saved` | SavedFilter |
| `/api/jobs/[id]/applications` | ApplicationRun |
| `/api/jobs/[id]/documents` | GeneratedDocument |
| `/api/profile/company-facts` | CompanyRelationshipFact |
| `/api/resume/documents/[id]` | ResumeDocument |
| `/api/resume/facts` | ResumeFact |
| `/api/resume/facts/[id]` | ResumeFact |
| `/api/resume/upload` | ResumeDocument |

### 3.2 Private data reached indirectly through `src/lib` (also unauthenticated)

These routes hold no `prisma.<privateModel>` call themselves but reach one
through a service module:

| Route | Path to private data |
| ----- | -------------------- |
| `/api/match` | `lib/matching.ts` → ResumeFact, MatchResult |
| `/api/jobs/[id]/generate-documents` | `lib/documents/generate.ts` → ResumeFact, ResumeBullet, GeneratedDocument, ApplicationProfile |
| `/api/jobs/[id]/deliver-documents` | `lib/documents/deliverLatest.ts` → GeneratedDocument |
| `/api/jobs/[id]/apply` | `lib/applications/queue.ts` → ApplicationRun |
| `/api/applications/[id]/answer`, `/retry`, `/resume` | `lib/applications/*` → ApplicationRun, ApplicationProfile, ApprovedAnswer |
| `/api/applications/settings` | `lib/applications/settings.ts` → AppSetting (personal keys) |
| `/api/documents/bullets/generate` | `lib/documents/bulletLibrary.ts` → ResumeFact, ResumeBullet |
| `/api/gmail/*` (5 routes) | `lib/gmail/*` → GmailAccount, TrackedEmail, AssessmentInboxEntry |
| `/api/resume/analyze` | résumé text → ResumeFact |
| `/api/nearby-firms/preference` | `lib/sync/nearbyDiscovery.ts` → AppSetting (personal key) |
| `/api/jobs`, `/api/jobs/counts`, `/api/jobs/[id]` | `Job.status`, `Job.matchScore`, `Job.eligibilityStatus` — personal columns on a global row |
| `/api/jobs/[id]/audit-log` | AuditLogEntry, including this person's application activity |
| `/api/agent-diagnostics`, `/safe-test` | `lib/applications/diagnostics.ts` → ApplicationProfile, ApplicationRun, GeneratedDocument |

### 3.3 Authenticated today (12)

`/api/profile/*` (answers, education, experience, project, entries, personal,
preferences, sensitive) authenticate through `resolveProfileOwner()` — but that
helper **returns `null` (the legacy owner) whenever single-user mode is on**,
which is the default. The extension routes (`/api/extension/*`) check the shared
global token, which identifies the installation, not a user.

### 3.4 Genuinely global — no change of ownership required

`/api/companies*`, `/api/approved-employers`, `/api/new-employer-review*`,
`/api/needs-review`, `/api/security-quarantine`, `/api/sync/*`,
`/api/scheduler/*`, `/api/jobs/[id]/verify`, `/api/jobs/score-unscored*`,
`/api/nearby-firms`, `/api/nearby-firms/search`, `/api/health/ollama`,
`/api/runtime`, `/api/extension/health`.

These still require a signed-in user (they are operator surfaces on shared
infrastructure) but no per-row ownership filter.

---

## 4. Storage

| What | Key today | Problem |
| ---- | --------- | ------- |
| Uploaded résumé | `data/resumes/<documentId>.pdf` | Not user-separated |
| Generated document | `data/generated/<jobId>/<type>-v<n>.pdf` | Not user-separated; two users applying to the same job write to one folder |
| Screenshots / browser logs | `ApplicationRun.screenshotPath` | Not user-separated |

Reads go through `readStoredObject(key)`, which resolves local disk or Vercel
Blob from the shape of the key. **Vercel Blob URLs are public and unguessable
but not authenticated** — a leaked URL is a leaked document forever. Downloads
must therefore go through an authenticated route that checks ownership, and new
keys must be written under `users/<userId>/…`.

---

## 5. AppSetting keys

| Key | Class |
| --- | ----- |
| `schedulerPaused`, `*Tick`, `atsImportStatus`, employer-sync keys | GLOBAL_SHARED |
| `greenhouseRealInspection`, `leverRealInspection`, `ollamaVisionPreflight`, `localFirmsDiagnostics`, `needsReviewAudit` | SYSTEM_INTERNAL (diagnostics) |
| `extensionApiToken` | **Replaced** — one global secret cannot scope to a user |
| `applicationMode`, `applicationAutoSubmitThreshold`, `applicationAutoSubmitAllowlist`, `keepFailedApplicationOpen` | **USER_PRIVATE** |
| nearby search centre + radius preference | **USER_PRIVATE** |

Personal keys move to a user-scoped settings model rather than staying in a
global key/value table.

---

## 6. Extension boundary

Today: the extension sends `Authorization: Bearer <token>` where the token is a
single value in `AppSetting.extensionApiToken` (or one env var). Any holder gets
`/api/extension/profile`, `/api/extension/approved-answers`,
`/api/extension/documents/[id]`, `/api/extension/fill-plan`, `/api/extension/runs/[id]`
— and those endpoints return *the* profile, because there is only one.

Hosted, that is a cross-account read. The replacement must:

- issue a token **bound to one `userId`**, minted only for a signed-in user;
- resolve the user from the token server-side on every request;
- never accept a `userId` from the extension;
- keep the database URL and every OAuth/auth secret out of the extension.

---

## 7. Authentication

**Today:** custom scrypt hashing (`lib/auth/password.ts`), opaque random session
tokens stored as SHA-256 digests (`lib/auth/session.ts`), a 30-day HttpOnly
cookie, and a hard gate (`lib/auth/mode.ts`) that 404s the auth routes whenever
`INTERNSHIP_PILOT_SINGLE_USER` is not explicitly falsy. The cryptography is
sound; what is missing is OAuth, account linking, session management UI, and
enforcement anywhere other than `/api/profile/*`.

**Plan:** Better Auth (`better-auth`, current stable `1.6.29`) with the Prisma
adapter over the existing PostgreSQL client and the existing `User` table
extended, not replaced. Email/password plus Google, with
`disableImplicitLinking` so an email/password account is never silently merged
into a Google identity. Google is linked only from Settings by an already
signed-in user.

Migration is safe rather than destructive: existing `User` rows keep their id
(every `userId` foreign key in this document points at it), the scrypt hash is
retained in a Better Auth credential account row, and `UserSession` is dropped
only after Better Auth's session table is live.

---

## 8. Plan of record

1. Better Auth over the existing `User` table; Google with explicit linking only.
2. `UserJobState`; personal columns removed from `Job` after data is copied.
3. `userId` on all twelve unowned private models, with cascade and indexes.
4. Per-user uniqueness: `CompanyRelationshipFact(userId, companyKey)`,
   `SavedFilter(userId, name)`, `ApplicationRun.activeKey` per user,
   `MatchResult(userId, jobId)`.
5. `ApplicationProfile` fields redistributed to the user-owned profile models.
6. `requireUser()` on every private route; `where: { userId: session.user.id }`
   on every private query; both id **and** owner checked on by-id routes.
7. User-scoped extension tokens.
8. User-separated storage keys plus authenticated download routes.
9. `scripts/claim-legacy-user-data.ts` — explicit target user, `--dry-run`,
   counts only, idempotent, refuses ambiguity.
10. Isolation tests: two users, same job, different scores, different statuses,
    no cross-account read on any private route.

Non-goals, explicitly: no rewrite of discovery, sync, verification, matching
prompts, document generation, or the local agent protocol. This work changes
*who* a row belongs to and *who* may ask for it, and nothing else.
