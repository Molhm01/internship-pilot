# Production deployment audit

An inventory of everything in Internship Pilot that assumed the web server and
the user share a computer, taken before any of it was changed.

Three classifications are used throughout, because conflating them is how a
test fixture gets "fixed" into a bug:

- **TEST ONLY** — appears in `scripts/test-*.ts`, `*.test.ts`, or a fixture.
  Never executed by the application. Not a deployment concern.
- **LOCAL DEVELOPMENT ONLY** — real application code that is only meaningful on
  a developer's or user's own machine.
- **PRODUCTION RUNTIME** — executes on a request the deployed server serves.
  These are the ones that had to change.

---

## 1. Database

**Before:** `prisma/schema.prisma` declared `provider = "sqlite"` with no `url`.
`src/lib/db.ts` built a `PrismaLibSql` adapter defaulting to `file:./dev.db`.
33 migrations under `prisma/migrations/`, `migration_lock.toml` pinned to
`sqlite`.

| Item | Classification | Finding |
| --- | --- | --- |
| `prisma/schema.prisma` datasource | PRODUCTION RUNTIME | SQLite. A serverless filesystem is ephemeral, so `file:./dev.db` is recreated empty on cold start and every write is lost. |
| `src/lib/db.ts` adapter | PRODUCTION RUNTIME | libsql, with a 15 s busy timeout for SQLite write-lock contention between the web app, scheduler, and worker. |
| `src/lib/db.ts` client cache | PRODUCTION RUNTIME | Cached on `globalThis` in development only. Serverless would build a new pool per module evaluation. |
| Schema portability | — | 33 models, only `String`/`Int`/`Float`/`Boolean`/`DateTime`. No `@db.*` attributes, no enums, no `Json`, no `Bytes`. Ports to PostgreSQL without a type change. |
| `contains` filters | PRODUCTION RUNTIME | 5 user-facing filters in `api/jobs` and `api/approved-employers`. SQLite's `LIKE` ignores ASCII case; PostgreSQL's does not. A silent search regression. |
| `equals` / `startsWith` filters | PRODUCTION RUNTIME | 6 sites. `equals` is case-sensitive on both providers; the one `startsWith` uses a generated key prefix. No behaviour change. |
| `dev.db`, 9 `dev.db.bak-*` files | LOCAL DEVELOPMENT ONLY | Real data. Must survive the migration untouched. |
| 10 `test-*.db`, `probe.db` | TEST ONLY | Scratch databases from regression scripts. |

## 2. Document and file storage

**Before:** `GeneratedDocument.storagePath` and `ResumeDocument.storagePath`
held repository-relative paths. Nine call sites resolved them with
`path.join(process.cwd(), …)` and `readFile`.

| Location | Classification | Finding |
| --- | --- | --- |
| `src/lib/documents/deliverLatest.ts` | PRODUCTION RUNTIME | `path.join(process.cwd(), relativePath)` then `readFile`. Named in the brief. |
| `src/app/api/documents/[id]/download/route.ts` | PRODUCTION RUNTIME | Same pattern. No containment check — a `storagePath` of `../../..` would have been read. |
| `src/app/api/extension/documents/[id]/route.ts` | PRODUCTION RUNTIME | Same pattern, behind extension auth and an ApplicationRun ownership check. |
| `src/app/api/application-sessions/route.ts` | PRODUCTION RUNTIME | `readFile` of each document before uploading it to the Agent. Had its own root containment check. |
| `src/app/api/applications/[id]/screenshot/route.ts` | PRODUCTION RUNTIME | `readFile` under `data/generated`, with a containment check. |
| `src/lib/resumeStorage.ts` | PRODUCTION RUNTIME | `mkdir` + `writeFile` into `data/resumes/` on every résumé upload. |
| `src/lib/documents/generate.ts` | LOCAL DEVELOPMENT ONLY | `mkdir` per job, writes `.typ` sources, invokes Typst, reads the compiled PDFs back. |
| `src/lib/applications/worker.ts`, `browserAgent.ts`, `formFiller.ts` | LOCAL DEVELOPMENT ONLY | Playwright `page.screenshot({ path })`. Runs in the separate local worker process, never in a request. |
| `src/lib/applications/browserProfile.ts` | LOCAL DEVELOPMENT ONLY | Persistent Chromium profile directory. |
| `src/lib/employers/csv.ts`, `src/lib/gmail/notify.ts` | LOCAL DEVELOPMENT ONLY | Reads a checked-in CSV; writes a local notification file. |

**Additional finding not in the brief:** `src/lib/documents/typst.ts` spawns the
Typst binary with `child_process`. Typst is not installed on a serverless host
and could not be, so **tailored document generation is inherently local-only** —
storage abstraction alone would not have made it work.

## 3. Local Agent (`127.0.0.1:4317`)

| Location | Classification | Finding |
| --- | --- | --- |
| `src/lib/documents/agentDelivery.ts` `agentBaseUrl()` | PRODUCTION RUNTIME | Defaults to `http://127.0.0.1:4317`, validates that the configured value *is* loopback, normalises `localhost` to IPv4. Correct locally, unreachable from a deployment. |
| `src/lib/documents/agentDelivery.ts` `deliverDocumentToAgent()` | PRODUCTION RUNTIME | POSTs the PDF with a 20 s timeout. On Vercel: 20 s of dead wait, then "the agent did not answer" — blaming the user's Agent for a call that never left the datacentre. |
| `src/app/api/application-sessions/route.ts` | PRODUCTION RUNTIME | Its own `agentBaseUrl()`, plus `GET/POST /documents` and `POST /application-sessions` against the Agent. |
| `src/lib/documents/deliverLatest.ts` | PRODUCTION RUNTIME | Calls `deliverDocumentToAgent`; reached from `/api/jobs/[id]/deliver-documents`. |
| `src/lib/documents/generate.ts` | LOCAL DEVELOPMENT ONLY | Delivers each PDF to the Agent as it is compiled. Already local-only via Typst. |
| `INTERNSHIP_AGENT_TOKEN_FILE` | LOCAL DEVELOPMENT ONLY | `readFileSync` of the Agent's own `local-data/agent-token.txt` at request time. Meaningless on Vercel. |
| `INTERNSHIP_AGENT_TOKEN` | LOCAL DEVELOPMENT ONLY | Fallback shared secret. Server-side only; never returned to the browser. |
| `route.test.ts`, `agentDelivery*.test.ts`, `applyFlow.test.ts` | TEST ONLY | Loopback URLs in fixtures. Not deployment bugs. |

**Already correct:** `src/lib/applications/extensionBridge.ts` transports the
whole application bundle — job context, profile snapshot, approved answers, and
the PDF bytes — to the extension over a same-origin `postMessage`. It names no
network address and contains no token. The job page already probes for it and
prefers it. This is the bridge the deployed architecture needs, and it already
existed.

## 4. Ollama (`localhost:11434`)

One module, `src/lib/ollama.ts`, owns the base URL. Seven server-side callers:

| Caller | Feature | Belongs to |
| --- | --- | --- |
| `src/lib/matching.ts` | AI Match eligibility and scoring | **A. Local Agent / local AI** |
| `src/app/api/resume/analyze/route.ts` | Résumé fact extraction | **A. Local Agent / local AI** |
| `src/lib/documents/select.ts` | Bullet/content selection for tailoring | **A. Local Agent / local AI** |
| `src/lib/documents/bulletLibrary.ts` | Résumé bullet generation | **A. Local Agent / local AI** |
| `src/lib/gmail/classify.ts` | Classifying tracked email | **A. Local Agent / local AI** |
| `src/lib/applications/browserAgent.ts` | Vision-driven form filling | **A. Local Agent** (also needs Playwright) |
| `src/lib/applications/diagnostics.ts` | Vision-model preflight | **A. Local Agent** |
| `src/app/api/health/ollama/route.ts` | Status badge probe | **C. Extension/runtime bridge** — must answer truthfully from either side |

Nothing in this list belongs to **B. Online server**: every one of them is
inference the product deliberately keeps on the user's machine.

`scripts/test-ollama*.ts` and `src/lib/ollamaMatchPerformance.test.ts` are
TEST ONLY.

## 5. Other local-execution dependencies

| Location | Classification | Finding |
| --- | --- | --- |
| `src/app/api/agent-diagnostics/safe-test/route.ts` | PRODUCTION RUNTIME | `execFile(process.execPath, [node_modules/tsx/…])`. Needs a checked-out repo and a `node_modules` tree. |
| `src/lib/applications/diagnostics.ts` | PRODUCTION RUNTIME | Imported Playwright at module scope to call `chromium.executablePath()`, pulling a ~300 MB dependency into the route bundle. |
| `src/lib/applications/worker.ts` + `workerLock.ts` | LOCAL DEVELOPMENT ONLY | Long-running single worker with a PID lockfile and heartbeat. Not a serverless shape at all. |
| `src/lib/jobs/captureDescription.ts` | LOCAL DEVELOPMENT ONLY | Playwright at module scope. Not imported by any route; used by scripts. |

## 6. Production URLs and OAuth

| Location | Classification | Finding |
| --- | --- | --- |
| `src/app/layout.tsx` | PRODUCTION RUNTIME | `metadataBase: new URL("http://localhost:3000")`. Every relative Open Graph and Twitter image would have resolved against the *visitor's* own machine. |
| `src/lib/gmail/oauth.ts` | PRODUCTION RUNTIME | `GMAIL_REDIRECT_URI` defaulting to `http://localhost:3000/api/gmail/auth/callback`. Google matches redirect URIs exactly, so a deployment would fail `redirect_uri_mismatch`. |
| `extension/dist/background.js` | PRODUCTION RUNTIME | `DEFAULT_BACKENDS` loopback-only, and `isLoopbackBase()` **rejected** any https origin. The extension could not have connected to a hosted website at all. |
| `extension/dist/manifest.json` | PRODUCTION RUNTIME | `connect-src` limited to `http://localhost:*` and `http://127.0.0.1:*`. |
| 12 `scripts/test-*.ts` `BASE_URL` defaults | TEST ONLY | Harness targets. Not deployment bugs. |

## 7. Auth, cookies, and secret exposure

| Item | Finding |
| --- | --- |
| `src/lib/auth/session.ts` | **Already correct.** `httpOnly: true`, `sameSite: "lax"`, `secure: process.env.NODE_ENV === "production"`. |
| `INTERNSHIP_PILOT_SINGLE_USER` | Defaults to `true`, which exposes the profile with no account. Correct for a single-user local install; **must be `false` on any deployment more than one person can reach.** |
| `src/lib/applications/extensionAuth.ts` | Bearer token compared with `timingSafeEqual`, generated with `randomBytes(32)` and persisted in `AppSetting`. Sound. |
| `NEXT_PUBLIC_*` usage | Before this work: none. No secret was ever exposed to the browser. |
| Agent token handling | Read server-side only, sent in an `x-agent-token` header, never in a URL, never logged. |
| Document bytes | Never logged; `contentBase64` is constructed and sent, never printed. |

## 8. Summary of blockers

| # | Blocker | Severity |
| --- | --- | --- |
| 1 | SQLite database on an ephemeral filesystem | Fatal — total data loss per cold start |
| 2 | Documents read and written through `process.cwd()` | Fatal — uploads vanish between requests |
| 3 | Server-side `fetch` to `127.0.0.1:4317` | Fatal — every Agent feature times out |
| 4 | Server-side Ollama at `localhost:11434` | Fatal — every AI feature fails, with a misleading message |
| 5 | Typst spawned as a child process | Fatal for document generation specifically |
| 6 | Playwright imported at route module scope | Severe — bundle size, and the feature cannot work regardless |
| 7 | `metadataBase` hard-coded to localhost | Moderate — broken link previews |
| 8 | Gmail redirect URI hard-coded to localhost | Fatal for Gmail — `redirect_uri_mismatch` |
| 9 | Extension refuses non-loopback backends | Fatal — the bridge could not reach a hosted site |
| 10 | Download routes had no path containment | Moderate — traversal via a database value |
| 11 | Prisma client built at module scope | Moderate — a missing `DATABASE_URL` fails the *build*, not a request |

Items 5, 6, 10, and 11 were found during the audit and are not in the original
brief.
