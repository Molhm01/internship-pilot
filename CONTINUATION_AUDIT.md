# Continuation Audit — 2026-08-02

Reconstruction of the state left behind when the previous session hit its usage
limit, and the decisions taken to continue from it.

Nothing in this file is taken on trust from the previous session's commit
messages or its terminal output. Every claim below was re-derived from the
repositories, the database, and re-run test suites.

---

## 1. Repositories and tooling

| Repository | Path | HEAD at audit time | Working tree |
| --- | --- | --- | --- |
| Internship Pilot (website) | `C:\Users\Molhm\Desktop\Internship-AI` | `d542af5` | dirty — 3 modified, 11 untracked paths |
| Application Agent (extension) | `C:\Users\Molhm\Desktop\Internship-Agent` | `3b5ec1f` | clean |

### Graphify

`graphify` is installed (`~/.local/bin/graphify`). Both graphs were rebuilt
before any file was read broadly.

- **Internship-Agent** had a graph at `graphify-out/` built from commit
  `4f4256e6`, i.e. **stale by five commits**. `graphify update .` rebuilt it:
  2226 nodes, 3978 edges, 155 communities.
- **Internship-AI** had **no graph at all**. Built one with
  `graphify . --code-only`: 2098 nodes, 4267 edges, 132 communities.

Graphify findings that changed the plan are recorded in section 4.

---

## 2. Baseline test and migration state (re-run, not assumed)

Measured *before* any change in this session, with the previous session's
uncommitted work still in the tree:

| Check | Result |
| --- | --- |
| Extension `npm run typecheck` | pass |
| Extension `npm test` | **694 passed, 1 skipped** (46 files passed, 1 skipped) |
| Website `npx vitest run` | **414 passed** (52 files) |
| `npx prisma migrate status` | 31 migrations found, database schema up to date |

So the previous session's reported numbers do still hold for the suites that
exist. What they do *not* prove is that the new code is correct — none of the
uncommitted profile/auth work has a single test covering it.

Database row counts (`dev.db`, read-only):

| Table | Rows |
| --- | --- |
| `ApplicationProfile` | **1** (`id = "default"`, real user data) |
| `Job` | 551 |
| `ResumeFact` | 51 |
| `GeneratedDocument` | 127 |
| `ApprovedAnswer` | 1 |
| `User`, `UserSession`, `UserProfile`, `Education`, `Experience`, `Project`, `ApplicationPreferences`, `SensitiveAnswerPreferences` | **0 each** |

This is the single most decisive fact in the audit and it is discussed in
section 4.

---

## 3. The interrupted file

`src/lib/profile/snapshot.ts` — **242 lines, not ~327.**

The terminal's "approximately 327 lines" does not match what is on disk. Either
the file was rewritten shorter after that report, or the count included content
that was never flushed. Treat the reported number as unreliable.

Assessed against the questions asked:

| Question | Answer |
| --- | --- |
| Does it compile? | **Yes.** It is syntactically complete, ends cleanly at `buildApprovedAnswers`, and `tsc` accepts it. |
| Does it read only saved values? | Yes. Every field goes through `text()`/`value()`/`numeric()` and is omitted when absent. No defaults. |
| Does it omit passwords and session secrets? | Yes. It reads `FullProfile`, whose `user` selection is `{ id, email, displayName }` — `passwordHash` is never selected, and no session field is touched. |
| Does it include all newly required profile sections? | **No.** Missing: no-middle-name flag, suffix, phone country code (loaded but not emitted), metro-region override, preferred website field, highest completed degree, availability term, salary minimum, marketing-text consent, job-source attribution, every company-relationship fact, and the employer-portal strategy. |
| Does the extension consume the same schema? | **Partly, by luck.** It emits a shape close to the extension's `profileSchema`, but nothing tests that, and there is no shared or contract-tested definition. |
| Is the bundle schema versioned? | **No.** Neither `applicationBundleTransferSchema` nor this snapshot carries a version. |
| Is incomplete-profile handling correct? | Only shallowly. `profileGaps()` checks nine fields; the canonical builder in the other implementation checks sixteen. |

**Verdict: the file compiles but is redundant.** See section 4.

---

## 4. The finding that reframes the work: two profile snapshots

Graphify's query for the bundle handoff surfaced this immediately:

```
NODE buildProfileSnapshot()  [src=src/lib/applications/profileSnapshot.ts loc=L248]
NODE missingProfileFields()  [src=src/lib/applications/profileSnapshot.ts loc=L393]
NODE buildAccountPreferences() [src=src/lib/applications/profileSnapshot.ts loc=L378]
NODE application-bundle/route.ts [src=src/app/api/application-bundle/route.ts]
```

There are **two** profile-snapshot implementations in the website:

| | `src/lib/applications/profileSnapshot.ts` | `src/lib/profile/snapshot.ts` |
| --- | --- | --- |
| State | **Committed** (`f19d9d9`) | Uncommitted, interrupted |
| Reads from | `ApplicationProfile` (1 real row) + `ResumeFact` | `User`/`UserProfile`/… (**0 rows**) |
| Wired to the extension | **Yes** — `/api/application-bundle` | **No** — nothing imports it |
| Has tests | Yes — `profileSnapshot.test.ts` | No |
| Account preferences | Yes | No |
| Missing-field audit | 16 checks | 9 checks |

The previous session was midway through replacing a working, wired, tested,
data-bearing profile with a parallel one backed by empty tables that requires a
login to reach — which is precisely the product misunderstanding the correction
calls out.

### Decision

**`ApplicationProfile` remains the canonical profile store, and
`src/lib/applications/profileSnapshot.ts` remains the one canonical snapshot
builder.** `src/lib/profile/snapshot.ts` is deleted rather than finished.

Reasons, in order of weight:

1. It holds the only real profile data. The alternative holds none, so choosing
   it would mean either a data migration or the user retyping everything.
2. `ApplicationProfile` is read by `documents/generate.ts`, `identityGuard.ts`,
   `worker.ts`, `validation.ts`, `diagnostics.ts`, `answerAndResume.ts` and six
   scripts. Those include tailored-document generation and résumé QA, which this
   task is explicitly forbidden from modifying.
3. `id @default("default")` — a single-row table — *is* a local single-user
   profile already. It needs no login by construction.

The new normalized tables and the website auth code are **preserved, not
deleted**, behind `INTERNSHIP_PILOT_SINGLE_USER`. They are additive, empty, and
cost nothing to keep for a future multi-user release.

---

## 5. Verification of the "known recent commits"

Inspected rather than trusted.

### Internship-Agent

| Commit | Claim | What is actually there |
| --- | --- | --- |
| `9fed2d6` | profile from bundle | Real. The extension reads `bundle.profile` rather than a second local copy. |
| `edc64f0` | sign-in/account/guest routes | Real and better than the message suggests: `shared/logic/navigationState.ts` classifies pages into nine kinds and extracts navigation intents with a precedence-ordered rule table. Covers the requested classification enum almost exactly. |
| `31208a5` | truthful AI status and password safety | Real. `isPasswordField`/`isUsernameField`/`isPasswordConfirmationField` exist; password fields are excluded from the answerable set that reaches the model. |
| `2b48c07` | popup validation | Real. |
| `3b5ec1f` | coverage and grounding gaps | Real. |

### Internship-AI

| Commit | Claim | What is actually there |
| --- | --- | --- |
| `f19d9d9` | canonical profile | Real — this is the `applications/profileSnapshot.ts` implementation kept above. |
| `d542af5` | sponsorship policy from explicit boolean | Real, and correctly refuses to emit a policy from a null. |

**No commit in either repository is misdescribed.** The problem is not a bad
commit; it is the uncommitted work layered on top of them.

---

## 6. What the extension already has, and what it is missing

Established from the refreshed graph plus targeted reads.

**Already present and working:**

- Page classification into login / account creation / guest / form / review /
  final submit / confirmation / blocked / unknown (`navigationState.ts`).
- CAPTCHA, MFA, and email-verification detection that outranks every other
  classification and produces a `blocked` page with an instruction to the user.
- An AES-GCM credential vault in IndexedDB with PBKDF2-600k key derivation, an
  in-memory-only passphrase, per-origin records, and a deliberate absence of any
  bulk accessor (`extension/src/credentials/vault.ts`).
- A random password generator.
- Bundle storage with document bytes in IndexedDB and a validated page bridge.
- Batched semantic form analysis, option discovery, combobox execution, DOM
  verification, and ATS adapters.
- The no-submit contract, enforced by schema (`z.literal(false)`), a database
  `CHECK` constraint, and a dedicated test.

**Missing, and therefore this session's work:**

- Password-*policy* detection and a generator that satisfies a detected policy.
  The current generator ignores site rules entirely.
- A deterministic account-creation executor. Nothing today acts on an
  `account_creation` classification.
- The employer-portal strategy preference (guest / create when required / always
  ask) and the auto-create setting with its one-time explicit confirmation.
- Company-relationship facts in the bundle and in the answer resolver.
- Bundle schema versioning and a cross-repository contract test.

---

## 7. Product correction, recorded

The requested feature is **employer-portal** account creation — Taleo, Workday,
iCIMS, SmartRecruiters, employer career sites — not Internship Pilot signup.

Accordingly:

- `/profile` opens directly and is the canonical profile editor. It does not
  redirect to `/login`.
- The profile form currently living on `/documents` moves to `/profile`; the
  documents page keeps a link to it. This removes a second editor of the same
  row rather than adding one.
- `/login`, `/signup`, `/logout`, `/api/auth/*`, `AuthForm.tsx`, `lib/auth/*`
  and the normalized tables stay in the tree, gated by
  `INTERNSHIP_PILOT_SINGLE_USER`. In single-user mode the sidebar shows no
  account links, and the auth routes refuse rather than half-work.

---

## 8. TODO/FIXME sweep

No `TODO`, `FIXME`, `XXX`, or `HACK` marker was left in either repository's
source by the interrupted work. The incompleteness is structural — a file that
nothing imports, a schema nothing versions — not annotated.

---

## 9. Risk register for the changes that follow

| Risk | Handling |
| --- | --- |
| Losing the one real `ApplicationProfile` row | Every schema change is additive (`ADD COLUMN`, `CREATE TABLE`). No column is dropped, renamed, or retyped. No `DROP`, no `NOT NULL` without a default. |
| Breaking document generation | `ApplicationProfile`'s existing columns are untouched; only new nullable columns are added. |
| A password reaching a model or a log | The model never receives a password field: password fields are filtered out of the answerable set, and filling is done by the deterministic executor reading the vault directly. |
| Auto-creating an account the user did not want | Default off; enabling requires one explicit confirmation; a blocked page (CAPTCHA/MFA/verification) always wins and pauses. |
| Clicking a final submit | Unchanged. The existing schema, database constraint, and test remain. |

---

## 10. What was done, and how it was verified

Added after the work, with the numbers each claim rests on.

### Commits

| Repo | Hash | Unit |
| --- | --- | --- |
| Internship-AI | `5f72b64` | Interrupted-state recovery |
| Internship-AI | `248462e` | Local profile access and bundle contract |
| Internship-Agent | `63fe509` | Profile schema v2 and bundle versioning |
| Internship-Agent | `beee185` | Employer account creation and credential vault |
| Internship-Agent | `1dcf158` | Taleo fields, company facts, required-field audit |

### Migrations

Both additive, applied, and verified against row counts taken before and after.

| Migration | What it does |
| --- | --- |
| `20260802180000_canonical_profile_fields` | 11 `ADD COLUMN` on `ApplicationProfile`, plus `CompanyRelationshipFact`. No drop, rename, retype, or `NOT NULL`. |
| `20260802190000_local_profile_entries` | Relaxes `userId` to nullable on `Education`/`Experience`/`Project`. All three were empty (verified `COUNT(*) = 0` first), so the rebuild copied nothing. |

Row counts unchanged across both: Job 551, MatchResult 676, GeneratedDocument
127, ResumeFact 51, ApprovedAnswer 1, ApplicationProfile 1.

### Test and build results

| Check | Before | After |
| --- | --- | --- |
| Extension tests | 694 passed, 1 skipped | **824 passed, 1 skipped** |
| Website tests | 414 passed | **439 passed** |
| Playwright | 21 passed | **21 passed** |
| Extension typecheck / lint / build / manifest verify | pass | pass |
| Website build | pass | pass |
| Website lint | 11 problems | 11 problems (identical; all pre-existing, none in changed files) |

### Bugs found by the new tests

Four, all of which would have misfired on a real employer form:

1. A stated password minimum of 8 was raised to the built-in default of 12,
   reporting a rule the site never made and becoming unsatisfiable on a site
   capped at 10.
2. `\b` word boundaries missed every plural — "special characters",
   "Passwords" — so a symbol prohibition was read as a demand.
3. Splitting page text into sentences cut a symbol allow-list in half at its
   own `!`.
4. `Master's Degree` normalized to `master s degree` and could never match a
   saved `Masters Degree` — a silent near-miss on a real degree dropdown.

Plus one regression left by the interrupted session: `ApprovedAnswer` gained a
compound unique key and three call sites still queried the old one.

And two greedy rules the existing lab caught: `/\bjob location\b/` swallowed
"Would you consider moving to the job location?", turning a relocation question
into a location preference.

### Live verification (HTTP)

Against the running instance on `localhost:3000`:

- `/profile` → 200, no redirect, renders "local single-user mode".
- `/login`, `/signup` → 404 in local mode; `POST /api/auth/signup` → 404 with a
  message naming `/profile`.
- `POST /api/application-profile` with no session → 200; reload returns every
  new field, and `gaps` goes from 11 entries to empty.
- The bundle carries `bundleVersion: 2`, `address.line2: "Apt 4C"` distinct
  from `line1`, `metroRegion` distinct from `city`, and
  `portalStrategy: create_when_required`.
- `companyRelationship` is present for an employer with saved facts, carrying
  `previouslyApplied: true` and `hasReferral: false` while **omitting** the two
  facts never recorded — and is absent entirely for an unknown employer.
- No password-shaped key or value anywhere in the bundle.

### Not verified

The end-to-end browser walkthrough was **not** performed: the Claude browser
extension is not connected to Chrome in this session, so no page was driven.
Everything above is HTTP-level or test-level evidence. The browser steps are
listed in the final report for the user to run.

### Preserved, not deleted

`ProfileSections.tsx`, `AuthForm.tsx`, `lib/auth/*`, `/api/auth/*`,
`/api/profile/{personal,preferences,sensitive,answers}`, `/login`, `/signup`,
`/logout`, and the `User`/`UserSession`/`UserProfile`/`ApplicationPreferences`/
`SensitiveAnswerPreferences` tables. All inert in local mode, all live when
`INTERNSHIP_PILOT_SINGLE_USER=false`.
